import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import NoteEditor from '$lib/components/NoteEditor.svelte';
import { AUTOSAVE_DEBOUNCE_MS } from '$lib/notes/autosave.svelte';
import { NotesStore } from '$lib/notes/notes.svelte';
import { notesStoreContext } from '$lib/notes/store-context';
import { createNotesRepository, type NotesRepository } from '$lib/notes/repository';
import type { NotesSync } from '$lib/notes/sync';
import { StorageFullError } from '$lib/notes/types';
import { navigationHarness, resetNavigationMock } from './helpers/navigation';

vi.mock('$app/navigation', async () => (await import('./helpers/navigation')).navigationMock());

/**
 * `NoteEditor` component tests (issue #7).
 *
 * Real storage (in-memory IndexedDB) and a real store, because the properties
 * under test are about what storage ends up holding: a debounce that fires the
 * wrong number of times, an empty note that should be gone, a failure that must
 * not lose the text. Only `setTimeout`/`clearTimeout` are faked, so the 500 ms
 * window is advanced instantly while IndexedDB keeps working on its own
 * `setImmediate` scheduling — faking that too would deadlock the write path.
 *
 * `$app/navigation` is the test double: the real module cannot be imported
 * outside a router, and the hooks it exposes are exactly what the editor uses
 * to flush before leaving. `navigationHarness()` drives them by hand.
 */

const silentSync = (): NotesSync => ({
	post() {},
	onRemoteChange: () => () => {},
	close() {}
});

let repository: NotesRepository | undefined;
let store: NotesStore | undefined;
const navigation = navigationHarness();

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	resetNavigationMock();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	const repo = createNotesRepository({ sync: silentSync() });
	repository = repo;
	const created = new NotesStore({ repository: repo, sync: silentSync() });
	store = created;
});

afterEach(async () => {
	vi.useRealTimers();
	store?.dispose();
	await store?.repository.close();
	await repository?.close();
	store = undefined;
	repository = undefined;
});

function currentStore(): NotesStore {
	if (!store) throw new Error('store not initialised');
	return store;
}

function currentRepository(): NotesRepository {
	if (!repository) throw new Error('repository not initialised');
	return repository;
}

/** Renders the editor over the shared store, as the routes do. */
function renderEditor(props: { noteId?: string | null; onCreated?: (id: string) => void } = {}) {
	return render(NoteEditor, { props, context: notesStoreContext(currentStore()) });
}

/** Seeds a note straight into storage, then loads the store. */
async function seed(body: string): Promise<string> {
	const created = await currentRepository().createNote(body);
	await currentStore().load();
	return created.id;
}

const textarea = () => screen.getByRole('textbox', { name: 'Note' }) as HTMLTextAreaElement;

/**
 * Types into the textarea the way a user does: set the value, then dispatch the
 * input event the component listens to.
 */
async function type(text: string): Promise<void> {
	const element = textarea();
	element.value = text;
	await fireEvent.input(element);
}

/**
 * Lets IndexedDB callbacks (real `setImmediate` macrotasks) and Svelte effects
 * run without moving the fake debounce clock.
 */
async function settle(rounds = 8): Promise<void> {
	for (let index = 0; index < rounds; index += 1) {
		await new Promise((resolve) => setImmediate(resolve));
		flushSync();
	}
}

/** Advances the debounce by exactly one window, letting the write settle. */
async function advanceDebounce(ms = AUTOSAVE_DEBOUNCE_MS): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	await settle();
}

/**
 * Polls `predicate` while letting real macrotasks and one fake tick through.
 * `waitFor` is unusable here: it is driven by `setTimeout`, which is fake.
 */
async function until(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		if (predicate()) return;
		await settle(1);
		await vi.advanceTimersByTimeAsync(1);
	}
	throw new Error(`condition never held: ${message}`);
}

describe('existing note', () => {
	it('renders the stored body in a labelled textarea', async () => {
		const id = await seed('# Hello\nbody text');
		renderEditor({ noteId: id });

		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');
		expect(textarea()).toHaveValue('# Hello\nbody text');
	});

	it('shows the created date from #6, never the updated date', async () => {
		const id = await seed('dated');
		renderEditor({ noteId: id });

		await until(() => screen.queryByTestId('editor-created-date') !== null, 'created date');
		const date = screen.getByTestId('editor-created-date');
		// `formatFullDate` renders a local date *and time*, e.g. "Oct 31, 2026, 7:04 PM".
		expect(date.textContent).toMatch(/\d{1,2}:\d{2}/);
		expect(date.textContent).toMatch(/\d{4}/);
		expect(screen.queryByText(/updated/i)).toBeNull();
	});

	it('does not focus an existing note, so opening one on a phone never pops the keyboard', async () => {
		const id = await seed('read only for now');
		renderEditor({ noteId: id });

		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');
		await settle();
		expect(document.activeElement).not.toBe(textarea());
	});

	it('says the note does not exist for an unknown id, with a link back', async () => {
		renderEditor({ noteId: 'no-such-note' });

		await until(() => screen.queryByTestId('editor-missing') !== null, 'missing state');
		expect(screen.getByTestId('editor-missing')).toHaveTextContent('This note doesn’t exist');
		expect(screen.getByRole('link', { name: 'Back to the list' })).toHaveAttribute('href', '/');
		expect(screen.queryByRole('textbox', { name: 'Note' })).toBeNull();
	});
});

describe('new note (create)', () => {
	it('opens empty and focused', async () => {
		renderEditor({ noteId: null });
		await settle();

		const element = textarea();
		expect(element).toHaveValue('');
		expect(document.activeElement).toBe(element);
	});

	it('persists nothing while the body is empty or whitespace-only', async () => {
		renderEditor({ noteId: null });
		await settle();

		await type('   ');
		await advanceDebounce();
		await type('\n\n\t \n');
		await advanceDebounce();

		expect(await currentRepository().listNotes()).toEqual([]);
		expect(navigation.replacements()).toEqual([]);
	});

	it('creates the note on the first non-whitespace character and rewrites the URL', async () => {
		const onCreated = vi.fn();
		renderEditor({ noteId: null, onCreated });
		await settle();

		await type('H');
		await settle();

		const stored = await currentRepository().listNotes();
		expect(stored).toHaveLength(1);
		expect(stored[0].body).toBe('H');

		// The URL now points at the real note — replaced, not pushed: the editor
		// is the same instance, so the caret is where the user left it.
		expect(navigation.replacements()).toEqual([`/notes/${stored[0].id}`]);
		expect(onCreated).toHaveBeenCalledWith(stored[0].id);
	});

	it('never creates a second note for later edits', async () => {
		renderEditor({ noteId: null });
		await settle();

		await type('first');
		await settle();
		await type('first and more');
		await advanceDebounce();
		await type('first and more, again');
		await advanceDebounce();

		const stored = await currentRepository().listNotes();
		expect(stored).toHaveLength(1);
		expect(stored[0].body).toBe('first and more, again');
		expect(navigation.replacements()).toHaveLength(1);
	});

	it('keeps focus and the caret in place across the URL rewrite', async () => {
		renderEditor({ noteId: null });
		await settle();

		const element = textarea();
		element.focus();
		await type('hello');
		// The caret sits mid-document from the component's point of view.
		element.setSelectionRange(2, 2);
		await settle();

		// Same element: a remount would replace the node and reset the selection.
		expect(textarea()).toBe(element);
		expect(document.activeElement).toBe(element);
		expect(element.selectionStart).toBe(2);
		expect(element.selectionEnd).toBe(2);
	});

	it('discards a new note that never got content when leaving', async () => {
		renderEditor({ noteId: null });
		await settle();

		await type('   ');
		await navigation.fireNavigate();

		expect(await currentRepository().listNotes()).toEqual([]);
	});
});

describe('autosave', () => {
	it('waits 500 ms after the last keystroke, then writes once', async () => {
		const id = await seed('start');
		renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		await type('st');
		await vi.advanceTimersByTimeAsync(300);
		await type('started');
		await vi.advanceTimersByTimeAsync(300);
		// 600 ms of typing, but only 300 ms since the last keystroke: nothing yet.
		expect((await currentRepository().getNote(id))?.body).toBe('start');

		await advanceDebounce(200);
		expect((await currentRepository().getNote(id))?.body).toBe('started');
	});

	it('announces "Saving…" while pending and "Saved" after success', async () => {
		const id = await seed('start');
		renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		const status = screen.getByTestId('editor-status');
		// Polite live region, not an alert: it must not interrupt typing.
		expect(status).toHaveAttribute('aria-live', 'polite');

		await type('changed');
		expect(status).toHaveTextContent('Saving…');

		await advanceDebounce();
		await until(() => status.textContent === 'Saved', 'Saved status');
	});

	it('flushes the pending write when the tab is hidden', async () => {
		const id = await seed('start');
		renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		await type('typed but not debounced');

		// The debounce has not fired yet; hiding the tab must write anyway.
		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			get: () => 'hidden'
		});
		document.dispatchEvent(new Event('visibilitychange'));
		await settle();

		expect((await currentRepository().getNote(id))?.body).toBe('typed but not debounced');
	});

	it('flushes the pending write on pagehide', async () => {
		const id = await seed('start');
		renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		await type('closed the window');
		window.dispatchEvent(new Event('pagehide'));
		await settle();

		expect((await currentRepository().getNote(id))?.body).toBe('closed the window');
	});

	it('flushes the pending write before an awaited navigation', async () => {
		const id = await seed('start');
		renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		await type('navigated away immediately');

		// SvelteKit calls `beforeNavigate` (sync) and awaits `onNavigate`.
		navigation.fireBeforeNavigate();
		await navigation.fireNavigate();

		expect((await currentRepository().getNote(id))?.body).toBe('navigated away immediately');
	});

	it('flushes the pending write on destroy', async () => {
		const id = await seed('start');
		const { unmount } = renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		await type('destroyed mid-typing');
		unmount();
		await settle();

		expect((await currentRepository().getNote(id))?.body).toBe('destroyed mid-typing');
	});

	/**
	 * The subtle one: two writes for the same note must never overlap.
	 *
	 * The store's `updateNote` is replaced with a save whose completion the test
	 * controls, so the window in which a second write could start is real rather
	 * than a race against a fast database. The counter records how many saves
	 * were open at the same time — the number the invariant is about.
	 */
	it('never runs two saves at once, and the latest text wins', async () => {
		const id = await seed('start');
		renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		const realUpdate = currentStore().updateNote.bind(currentStore());
		const bodies: string[] = [];
		const pending: { body: string; resolve: () => void }[] = [];
		let inFlight = 0;
		let maxInFlight = 0;

		const spy = vi.spyOn(currentStore(), 'updateNote').mockImplementation((async (
			noteId: string,
			next: string
		) => {
			bodies.push(next);
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				await new Promise<void>((resolve) => {
					pending.push({ body: next, resolve });
				});
				return await realUpdate(noteId, next);
			} finally {
				inFlight -= 1;
			}
		}) as unknown as NotesStore['updateNote']);

		await type('first write');
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
		await settle();
		expect(bodies).toEqual(['first write']);
		expect(pending).toHaveLength(1);

		// Typed while the first write is still open, then the tab is hidden: the
		// flush has to join the in-flight write, not start a second one.
		await type('second write');
		window.dispatchEvent(new Event('pagehide'));
		await settle();

		expect(bodies).toEqual(['first write']);
		expect(maxInFlight).toBe(1);

		// Completing the first write lets the queue take the newer body — once.
		pending[0].resolve();
		await settle();
		expect(bodies).toEqual(['first write', 'second write']);
		expect(maxInFlight).toBe(1);

		pending[1].resolve();
		await settle();

		expect(bodies).toEqual(['first write', 'second write']);
		expect((await currentRepository().getNote(id))?.body).toBe('second write');

		spy.mockRestore();
	});
});

describe('save failure', () => {
	it('shows the alert, keeps the text, and retries from the button', async () => {
		const id = await seed('start');
		renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		const failing = vi
			.spyOn(currentStore(), 'updateNote')
			.mockRejectedValueOnce(new StorageFullError());

		await type('text that must not be lost');
		await advanceDebounce();

		const alert = screen.getByTestId('editor-save-error');
		expect(alert).toHaveAttribute('role', 'alert');
		expect(alert).toHaveTextContent("Couldn't save — your changes are still on screen");
		expect(alert).toHaveTextContent('Storage is full');
		// The text is still there, in the editor, and storage still has the old one.
		expect(textarea()).toHaveValue('text that must not be lost');
		expect((await currentRepository().getNote(id))?.body).toBe('start');

		failing.mockRestore();
		await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		await settle();

		expect(screen.queryByTestId('editor-save-error')).toBeNull();
		expect((await currentRepository().getNote(id))?.body).toBe('text that must not be lost');
	});

	it('retries on the next keystroke', async () => {
		const id = await seed('start');
		renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		const failing = vi
			.spyOn(currentStore(), 'updateNote')
			.mockRejectedValueOnce(new StorageFullError());

		await type('v1');
		await advanceDebounce();
		expect(screen.getByTestId('editor-save-error')).toBeInTheDocument();
		failing.mockRestore();

		await type('v1 more');
		await advanceDebounce();

		await until(() => screen.queryByTestId('editor-save-error') === null, 'alert cleared');
		expect((await currentRepository().getNote(id))?.body).toBe('v1 more');
	});

	it('gives the failed text one more chance when leaving, instead of dropping it', async () => {
		const id = await seed('start');
		const { unmount } = renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		const failing = vi
			.spyOn(currentStore(), 'updateNote')
			.mockRejectedValueOnce(new StorageFullError());

		await type('the disk was full for a moment');
		await advanceDebounce();
		expect(screen.getByTestId('editor-save-error')).toBeInTheDocument();
		failing.mockRestore();

		// Destroy is the last moment the text can reach storage.
		unmount();
		await settle();

		expect((await currentRepository().getNote(id))?.body).toBe('the disk was full for a moment');
	});
});

describe('empty note on leave', () => {
	it('deletes the note silently when it is left empty', async () => {
		const id = await seed('will be emptied');
		const { unmount } = renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		await type('');
		unmount();
		await settle();

		expect(await currentRepository().listNotes()).toEqual([]);
		// No toast: the silence is the requirement, and sonner is not even mounted.
		expect(document.querySelector('[data-sonner-toaster]')).toBeNull();
	});

	it('deletes it on an awaited navigation too, without writing the empty body', async () => {
		const id = await seed('will be emptied by navigating');
		renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		await type('   ');
		await navigation.fireNavigate();

		expect(await currentRepository().listNotes()).toEqual([]);
	});

	it('keeps a note that still has content, even with surrounding whitespace', async () => {
		const id = await seed('kept');
		const { unmount } = renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		await type('  kept  ');
		unmount();
		await settle();

		expect((await currentRepository().getNote(id))?.body).toBe('  kept  ');
	});
});

describe('changes from another tab', () => {
	it('adopts a body written elsewhere when there is nothing unsaved', async () => {
		const id = await seed('original');
		renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		// Another tab writes, and the shared store reloads that note.
		await currentRepository().updateNote(id, 'from the other tab');
		await currentStore().load();
		await settle();

		await until(() => textarea().value === 'from the other tab', 'remote body adopted');
	});

	it('keeps local unsaved text instead (last write wins)', async () => {
		const id = await seed('original');
		renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		await type('mine, not saved yet');
		// Arrives before the debounce: this editor has unsaved changes.
		await currentRepository().updateNote(id, 'from the other tab');
		await currentStore().load();
		await settle();

		expect(textarea()).toHaveValue('mine, not saved yet');
	});

	it('says the note was deleted in another tab, with a link back', async () => {
		const id = await seed('about to go');
		renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		await currentRepository().deleteNote(id);
		await currentStore().load();
		await settle();

		await until(() => screen.queryByTestId('editor-deleted') !== null, 'deleted state');
		expect(screen.getByTestId('editor-deleted')).toHaveTextContent(
			'This note was deleted in another tab'
		);
		expect(screen.getByRole('link', { name: 'Back to the list' })).toHaveAttribute('href', '/');
	});

	it('keeps the caret where it was when adopting a remote body', async () => {
		const id = await seed('abcdef');
		renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		const element = textarea();
		element.focus();
		element.setSelectionRange(3, 3);
		await currentRepository().updateNote(id, 'abcdef plus more');
		await currentStore().load();
		await settle();

		await until(() => element.value === 'abcdef plus more', 'remote body adopted');
		expect(element.selectionStart).toBe(3);
	});
});

describe('keyboard', () => {
	it('Esc flushes the save before leaving', async () => {
		const id = await seed('start');
		renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		await type('typed then escaped');
		await fireEvent.keyDown(textarea(), { key: 'Escape' });
		await settle();

		expect((await currentRepository().getNote(id))?.body).toBe('typed then escaped');
	});

	it('Ctrl/Cmd+Enter does the same as Esc', async () => {
		const id = await seed('start');
		renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		await type('typed then command-enter');
		await fireEvent.keyDown(textarea(), { key: 'Enter', ctrlKey: true });
		await settle();

		expect((await currentRepository().getNote(id))?.body).toBe('typed then command-enter');
	});
});

describe('marked slots for later issues', () => {
	it('has a marked, empty slot for the Delete action (#8) and the view tabs (#9)', async () => {
		const id = await seed('slot host');
		const { container } = renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		expect(container.querySelector('[data-placeholder-for="8-delete"]')).not.toBeNull();
		expect(container.querySelector('[data-placeholder-for="9-view-tabs"]')).not.toBeNull();

		// And neither feature is implemented: no delete control, no tabs, no preview.
		expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
		expect(screen.queryByRole('tablist')).toBeNull();
		expect(screen.queryByRole('tab', { name: /preview/i })).toBeNull();
	});

	it('offers no Save button: saving is automatic', async () => {
		const id = await seed('no save button');
		renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
	});
});
