<script lang="ts">
	import { browser } from '$app/environment';
	import { afterNavigate, beforeNavigate, goto, onNavigate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { tick, untrack } from 'svelte';
	import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { NoteAutosave } from '$lib/notes/autosave.svelte';
	import { formatFullDate } from '$lib/notes/date';
	import { replaceNoteUrl } from '$lib/notes/note-url';
	import { getNotesStore } from '$lib/notes/store-context';

	/**
	 * The note editor (#7): a plain-text Markdown source editor that autosaves.
	 *
	 * The one promise this component makes is that typed text is never dropped.
	 * Every mechanism below exists for a specific way that promise could break:
	 *
	 * - the debounce only decides *when* a write starts; leaving (navigation,
	 *   hide, close, destroy, `Esc`) flushes first;
	 * - writes are single-flight and always use the latest text
	 *   (`NoteAutosave`), so a slow write can never land after a newer one;
	 * - a failed write keeps the text on screen, shows the alert and retries on
	 *   the button or on the next keystroke;
	 * - a body from another tab is only adopted when this editor has nothing
	 *   unsaved (last write wins), and a note deleted elsewhere says so instead
	 *   of silently emptying the editor.
	 *
	 * `noteId` is `null` on `/notes/new`: nothing is persisted until the first
	 * non-whitespace character, and that first character *creates* the note and
	 * rewrites the URL with `replaceState` — a shallow history update, so this
	 * component is never remounted and the caret is never touched.
	 *
	 * One instance owns exactly one note: the `[id]` route keys the component by
	 * id, so a different note is a different instance. That is what makes the
	 * "one note per editor" invariant structural instead of a convention —
	 * there is no sequence of events in which a save could target the note the
	 * user just navigated to.
	 */
	type Props = {
		/** Note in the URL; `null` while creating a new one. */
		noteId?: string | null;
		/** Reports the id a new note got, so the list can highlight its row. */
		onCreated?: (id: string) => void;
	};

	let { noteId = null, onCreated }: Props = $props();

	const store = getNotesStore();

	/** Same breakpoint the layout uses (`md`, 768 px): CSS decides, we ask it. */
	const WIDE_QUERY = '(min-width: 768px)';

	/**
	 * The id this editor is bound to; becomes the created id for a new note.
	 *
	 * Read once on mount, deliberately: an instance owns exactly one note, and
	 * the `[id]` route keys the component by id, so a different note is a
	 * different instance. `untrack` states that instead of leaving it implied.
	 */
	let currentId = $state<string | null>(untrack(() => noteId));
	/** The text on screen: the single source of truth while editing. */
	let body = $state('');
	/**
	 * The body this editor last saw committed — its own successful write, or a
	 * body it adopted from another tab. A stored body equal to it is an echo of
	 * something already accounted for, not a new edit from elsewhere.
	 */
	let knownBody = $state<string | null>(null);
	let textarea = $state<HTMLTextAreaElement | null>(null);
	/** The note has been on screen at least once, so an absence means "deleted". */
	let everPresent = $state(false);
	/** A leave is in progress: keep the current UI instead of flashing a state. */
	let departing = $state(false);

	/**
	 * The layout loads the store it owns, so "settled" is simply "that read
	 * finished": before it, a missing note proves nothing (it may still arrive).
	 */
	const settled = $derived(store.status !== 'loading');

	/** The stored record for `currentId`, kept live by the shared store. */
	const stored = $derived(
		currentId === null ? null : (store.notes.find((note) => note.id === currentId) ?? null)
	);

	type Phase = 'blank' | 'loading' | 'ready' | 'missing' | 'deleted' | 'unavailable';

	const phase = $derived.by<Phase>(() => {
		if (currentId === null) return 'blank';
		if (stored !== null) return 'ready';
		// While leaving, a delete we just issued ourselves must not be reported
		// as "deleted in another tab": hold the current view until we are gone.
		if (departing) return 'ready';
		if (store.status === 'error') return 'unavailable';
		if (!settled) return 'loading';
		return everPresent ? 'deleted' : 'missing';
	});

	const hasContent = (text: string): boolean => text.trim().length > 0;

	const autosave = new NoteAutosave({ save: persist });

	/**
	 * Writes `next` for *this* editor's note. Creating is the only case where
	 * the target id changes, and it changes exactly once, before any update
	 * could be queued against the wrong note.
	 */
	async function persist(next: string): Promise<void> {
		if (currentId === null) {
			const created = await store.createNote(next);
			// Before the URL changes: the list needs the id to highlight the row,
			// and a save queued behind this one must `updateNote`, not create again.
			currentId = created.id;
			knownBody = created.body;
			onCreated?.(created.id);
			// Shallow routing: the history entry is rewritten in place, so the
			// textarea, its focus and its caret are untouched.
			if (browser) replaceNoteUrl(created.id);
			return;
		}
		const updated = await store.updateNote(currentId, next);
		knownBody = updated.body;
	}

	/**
	 * Adopts a body written by another tab, keeping the caret where it was.
	 * Only reached when this editor has nothing unsaved (see the effect below).
	 */
	async function adoptRemoteBody(next: string): Promise<void> {
		const element = textarea;
		const focused = element !== null && document.activeElement === element;
		const start = focused ? element.selectionStart : 0;
		const end = focused ? element.selectionEnd : 0;
		body = next;
		// Accounted for: this is now what the screen and storage agree on, so its
		// echo through the store must not be mistaken for a further edit.
		knownBody = next;
		if (!focused) return;
		// A programmatic value change puts the caret at the end; put it back,
		// clamped to a body that may now be shorter.
		await tick();
		const limit = element.value.length;
		element.setSelectionRange(Math.min(start, limit), Math.min(end, limit));
	}

	/**
	 * The work every exit path shares: keep the latest text, or drop a note the
	 * user emptied. Idempotent — navigation and destroy both call it, and the
	 * second call joins the first instead of deleting twice or returning early
	 * (returning early would let `onNavigate` release the navigation while the
	 * write it asked for was still in flight).
	 */
	let leaving: Promise<void> | null = null;
	function leave(): Promise<void> {
		leaving ??= depart();
		return leaving;
	}

	async function depart(): Promise<void> {
		departing = true;

		if (hasContent(body)) {
			// Content means the note must exist, so this flushes the latest text —
			// and on a note that is still being created it *creates* it, which is
			// why the id is read after the flush rather than before: a keystroke
			// that leaves while the first write is still in flight must not be
			// dropped just because the note did not exist yet when leave started.
			await autosave.flush();
			return;
		}

		// Empty or whitespace-only: nothing worth keeping. Dropping the pending
		// write keeps an empty body out of storage; the record itself (if a create
		// is still in flight, one is about to appear) is removed below.
		const creating = autosave.isSaving && currentId === null;
		autosave.stop();
		if (creating) {
			// Wait for the create to land so its id is known and can be removed,
			// instead of leaving an empty note behind.
			await autosave.flush();
		}

		const id = currentId;
		if (id === null || !everPresent) return;
		// Silently: deleting the text is how the user asked for the note to go, so
		// a toast would only confirm what they already did.
		await store.deleteNote(id).catch(() => undefined);
	}

	/** Hide/close: persist what is pending, but never delete — they may return. */
	function flushPending(): void {
		void autosave.flush();
	}

	function focusListRow(): void {
		const current =
			currentId === null
				? null
				: document.querySelector<HTMLElement>(
						`[data-slot="note-row"][data-note-id="${currentId}"]`
					);
		const first = document.querySelector<HTMLElement>('[data-slot="note-row"]');
		(current ?? first)?.focus();
	}

	/** `Esc` / `Ctrl+Enter`: save, then hand focus back to the list. */
	async function leaveFromKeyboard(): Promise<void> {
		const wide = typeof window.matchMedia === 'function' && window.matchMedia(WIDE_QUERY).matches;
		await leave();
		if (wide) {
			focusListRow();
			return;
		}
		await goto(resolve('/'));
	}

	function onkeydown(event: KeyboardEvent): void {
		const isEscape = event.key === 'Escape';
		const isSubmit = event.key === 'Enter' && (event.metaKey || event.ctrlKey);
		if (!isEscape && !isSubmit) return;
		event.preventDefault();
		void leaveFromKeyboard();
	}

	function oninput(event: Event): void {
		const element = event.currentTarget as HTMLTextAreaElement;
		body = element.value;
		if (currentId === null) {
			// A new note exists only once it has something to say: whitespace is
			// not content, so there is no write and no URL change.
			if (!hasContent(body)) return;
			// Immediate, because this write is what turns the empty editor into a
			// real note: its row appears in the list and the URL becomes real
			// without a half-second of "typing into nothing".
			autosave.update(body, { immediate: true });
			return;
		}
		autosave.update(body);
	}

	function retrySave(): void {
		void autosave.retry();
	}

	// --- lifecycle -----------------------------------------------------------

	// The list also loads the shared store, but the editor must not depend on a
	// sibling being mounted to know whether its note exists (`load()` is
	// idempotent: a second caller joins the same read).
	$effect(() => {
		if (store.status === 'loading') void store.load();
	});

	// First sight of the stored note: that body is what the editor shows, and it
	// is already "known", so it can never be mistaken for a change to adopt.
	$effect(() => {
		if (stored === null) return;
		everPresent = true;
		if (knownBody !== null) return;
		body = stored.body;
		knownBody = stored.body;
	});

	// Adopt a body from another tab unless this editor has unsaved changes:
	// last write wins means the local text is kept, never merged or overwritten.
	//
	// Two bodies must be ignored even when nothing is unsaved: the one already on
	// screen, and the one this editor itself just wrote. Without the second check
	// a save in flight would come back through the shared store and overwrite the
	// characters typed after it started — the exact loss this issue is about.
	$effect(() => {
		const next = stored?.body;
		if (next === undefined || next === body || next === knownBody) return;
		if (autosave.hasUnsavedChanges) return;
		void adoptRemoteBody(next);
	});

	// Gone elsewhere: stop writing into a note that no longer exists.
	$effect(() => {
		if (phase === 'deleted') autosave.stop();
	});

	// A new note opens focused; an existing one does not, so opening a note on a
	// phone to read it never pops the on-screen keyboard.
	//
	// Two calls on purpose. This one focuses as soon as the textarea exists, and
	// `afterNavigate` below focuses again: SvelteKit resets focus (to the root,
	// blurs the active element) *after* the component tree is committed and
	// before `afterNavigate` runs, so an effect alone leaves a new note with the
	// caret nowhere and the first keystrokes going to `<body>`.
	$effect(() => {
		if (currentId !== null || textarea === null) return;
		textarea.focus();
	});

	// Flush on hide/close. A real unload can kill a write that has not started
	// yet, so the write must begin at `visibilitychange`, not at `pagehide`.
	$effect(() => {
		if (!browser) return;
		const onVisibility = () => {
			if (document.visibilityState === 'hidden') flushPending();
		};
		document.addEventListener('visibilitychange', onVisibility);
		window.addEventListener('pagehide', flushPending);
		return () => {
			document.removeEventListener('visibilitychange', onVisibility);
			window.removeEventListener('pagehide', flushPending);
		};
	});

	// The issue's contract: flush on `beforeNavigate`. SvelteKit cannot await
	// it, so `onNavigate` (which it *does* await) carries the same work — that is
	// what makes "type, then navigate away immediately" land in storage before
	// the route changes. Destroy covers every other way out of the component.
	beforeNavigate(() => {
		void leave();
	});
	onNavigate(async () => {
		await leave();
	});
	$effect(() => {
		return () => {
			void leave();
		};
	});

	// Focus a brand-new note once the router has finished its own focus reset.
	afterNavigate(() => {
		if (currentId === null && textarea !== null && !departing) textarea.focus();
	});

	const createdLabel = $derived(stored ? formatFullDate(stored.createdAt) : '');
	const isBusy = $derived(autosave.status === 'pending' || autosave.status === 'saving');
	const statusText = $derived(isBusy ? 'Saving…' : autosave.status === 'saved' ? 'Saved' : '');
	const saveError = $derived(autosave.status === 'error' ? autosave.error : null);
</script>

{#if phase === 'loading'}
	<p class="sr-only" role="status" data-testid="editor-loading">Loading note…</p>
{:else if phase === 'missing' || phase === 'deleted' || phase === 'unavailable'}
	<div class="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center">
		{#if phase === 'deleted'}
			<p class="text-base font-medium" data-testid="editor-deleted">
				This note was deleted in another tab
			</p>
		{:else if phase === 'missing'}
			<p class="text-base font-medium" data-testid="editor-missing">
				This note doesn&rsquo;t exist
			</p>
		{:else}
			<p class="text-base font-medium" data-testid="editor-unavailable">
				Your notes can&rsquo;t be read right now
			</p>
			<p class="text-sm text-muted-foreground">{store.error?.message ?? ''}</p>
		{/if}
		<Button href={resolve('/')} variant="outline" class="min-h-11 px-4" data-testid="editor-back"
			>Back to the list</Button
		>
	</div>
{:else}
	<div
		class="flex min-h-full min-w-0 flex-col"
		data-slot="note-editor"
		data-note-id={currentId ?? ''}
	>
		<header class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-1.5">
			<!--
				#9 EDIT / PREVIEW TAB SLOT — the Edit/Preview tabs (and the ≥xl
				side-by-side preview) mount here. Deliberately empty in #7.
			-->
			<div class="hidden" data-placeholder-for="9-view-tabs" aria-hidden="true"></div>

			{#if createdLabel}
				<p class="text-xs text-muted-foreground" data-testid="editor-created-date">
					{createdLabel}
				</p>
			{/if}

			<div class="ml-auto flex items-center gap-2">
				<p
					role="status"
					aria-live="polite"
					class="text-xs text-muted-foreground"
					data-testid="editor-status"
				>
					{statusText}
				</p>
				<!--
					#8 DELETE ACTION SLOT — the Delete button (with its Undo toast)
					mounts here. Deliberately empty in #7: no delete UI exists yet.
				-->
				<div class="hidden" data-placeholder-for="8-delete" aria-hidden="true"></div>
			</div>
		</header>

		{#if saveError}
			<div class="shrink-0 px-4 pt-3">
				<Alert variant="destructive" data-testid="editor-save-error">
					<AlertTitle>Couldn't save — your changes are still on screen</AlertTitle>
					<AlertDescription>
						<p>{saveError.message}</p>
						<Button
							variant="outline"
							size="sm"
							class="mt-2 min-h-11 px-4"
							data-testid="editor-retry"
							onclick={retrySave}
						>
							Retry
						</Button>
					</AlertDescription>
				</Alert>
			</div>
		{/if}

		<div class="flex min-h-0 flex-1 flex-col px-4 pt-3 pb-4">
			<label for="note-body" class="sr-only">Note</label>
			<Textarea
				id="note-body"
				bind:ref={textarea}
				value={body}
				{oninput}
				{onkeydown}
				data-testid="note-body"
				class="min-h-full flex-1 resize-none border-0 bg-transparent px-0 py-0 font-mono text-base shadow-none focus-visible:ring-2 md:text-sm"
			/>
		</div>
	</div>
{/if}
