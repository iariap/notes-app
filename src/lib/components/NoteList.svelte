<script lang="ts">
	import { resolve } from '$app/paths';
	import { Tooltip as TooltipPrimitive } from 'bits-ui';
	import { untrack } from 'svelte';
	import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Tooltip, TooltipContent, TooltipProvider } from '$lib/components/ui/tooltip/index.js';
	import { NotesStore, type NotesStatus } from '$lib/notes/notes.svelte';
	import { derivePreview } from '$lib/notes/preview';
	import { deriveTitle } from '$lib/notes/title';
	import type { Note } from '$lib/notes/types';
	import NoteListRow from './NoteListRow.svelte';

	/**
	 * The notes list: the screen the app opens on.
	 *
	 * Three rendering states and one empty state, all driven by the store from
	 * #4 — the component never reads storage itself and never mutates it, so
	 * there is nothing here that can delete or overwrite a note.
	 *
	 * `store` is optional so a caller that already has one (the editor route in
	 * #7) can share it; when it is omitted the list owns its own store and
	 * disposes it on unmount.
	 */
	type Props = {
		store?: NotesStore;
		activeNoteId?: string | null;
	};

	let { store, activeNoteId = null }: Props = $props();

	// The store is created once, from the props as they were on mount: a caller
	// that wants a different store remounts the list rather than swapping it.
	const owned = untrack(() => store ?? new NotesStore());
	const ownsStore = untrack(() => store === undefined);

	$effect(() => {
		// Loading here (not in the caller) keeps the list correct wherever it is
		// mounted, including a shared store: `load()` is idempotent, and the store
		// itself drops a slow result that a newer write superseded.
		void owned.load();
		if (!ownsStore) return;
		return () => {
			owned.dispose();
			void owned.repository.close();
		};
	});

	/**
	 * Relative labels ("2 hours ago") have to age on their own: the list is
	 * opened once and left open, so a single tick per minute re-renders only the
	 * date labels and never reloads or re-reads storage.
	 */
	const CLOCK_INTERVAL_MS = 60_000;
	let now = $state(new Date());

	$effect(() => {
		// Aligned to the next whole minute so the label changes when the minute
		// does, not 60 s after the page happened to mount.
		const alignment = CLOCK_INTERVAL_MS - (Date.now() % CLOCK_INTERVAL_MS);
		let interval: ReturnType<typeof setInterval> | undefined;
		const timeout = setTimeout(() => {
			now = new Date();
			interval = setInterval(() => {
				now = new Date();
			}, CLOCK_INTERVAL_MS);
		}, alignment);
		return () => {
			clearTimeout(timeout);
			if (interval !== undefined) clearInterval(interval);
		};
	});

	const status = $derived<NotesStatus>(owned.status);
	const error = $derived<Error | null>(owned.error);
	const notes = $derived<Note[]>(owned.notes);

	/**
	 * Title and preview are derived once per note, not on every render: the
	 * minute tick only changes `now`, and this derived does not read it, so a
	 * list of 1,000 notes re-renders dates without re-parsing 1,000 bodies.
	 */
	const rows = $derived(
		notes.map((note) => ({
			note,
			title: deriveTitle(note.body),
			preview: derivePreview(note.body)
		}))
	);

	/** Rows the loading skeleton draws: enough to fill a short viewport. */
	const SKELETON_ROWS = 6;
	const skeletonRows = Array.from({ length: SKELETON_ROWS }, (_, index) => index);

	/**
	 * One tether and one tooltip root for the whole list, shared by every row.
	 *
	 * A `Tooltip` per row is the obvious shape and the wrong one at scale: each
	 * root builds its own presence manager, timeout and watchers, which cost
	 * ~146 ms of first render at 1,000 notes (231 ms vs 85 ms measured). With the
	 * tether, rows only register a trigger and the single root renders whichever
	 * full date is active.
	 */
	const tether = TooltipPrimitive.createTether<string>();
</script>

<div data-slot="note-list" class="flex min-w-0 flex-col p-2">
	{#if status === 'error' && error}
		<Alert data-testid="note-list-error">
			<AlertTitle>Couldn&rsquo;t load your notes</AlertTitle>
			<AlertDescription>{error.message}</AlertDescription>
		</Alert>
	{:else if status === 'loading'}
		<p class="sr-only" role="status">Loading notes…</p>
		<ul class="flex flex-col gap-1" aria-hidden="true" data-testid="note-list-skeleton">
			{#each skeletonRows as row (row)}
				<li class="flex min-h-11 flex-col justify-center gap-1.5 px-3 py-2">
					<div class="h-3.5 w-2/3 animate-pulse rounded-sm bg-muted"></div>
					<div class="h-3 w-full animate-pulse rounded-sm bg-muted"></div>
				</li>
			{/each}
		</ul>
	{:else if notes.length === 0}
		<div
			class="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center"
			data-slot="note-list-empty"
			data-testid="note-list-empty"
		>
			<p class="text-base font-medium">No notes yet</p>
			<Button href={resolve('/notes/new')} size="lg" class="min-h-11 px-4">New note</Button>
		</div>
	{:else}
		<TooltipProvider>
			<ul class="flex flex-col gap-1" data-testid="note-list-items">
				{#each rows as row (row.note.id)}
					<li class="min-w-0">
						<NoteListRow
							note={row.note}
							title={row.title}
							preview={row.preview}
							active={row.note.id === activeNoteId}
							{now}
							{tether}
						/>
					</li>
				{/each}
			</ul>
			<Tooltip {tether}>
				{#snippet children({ payload })}
					<TooltipContent side="top" align="start">
						<span data-slot="note-row-full-date">{payload ?? ''}</span>
					</TooltipContent>
				{/snippet}
			</Tooltip>
		</TooltipProvider>
	{/if}
</div>
