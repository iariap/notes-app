import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import NoteEditor from '$lib/components/NoteEditor.svelte';
import NoteList from '$lib/components/NoteList.svelte';
import { Toaster } from '$lib/components/ui/sonner/index.js';
import { AUTOSAVE_DEBOUNCE_MS } from '$lib/notes/autosave.svelte';
import { resetDeleteUndoForTests } from '$lib/notes/delete-undo';
import { NotesStore } from '$lib/notes/notes.svelte';
import { createNotesRepository, type NotesRepository } from '$lib/notes/repository';
import { notesStoreContext } from '$lib/notes/store-context';
import type { NotesSync } from '$lib/notes/sync';
import { toast } from 'svelte-sonner';
import { resetNavigationMock } from './helpers/navigation';

vi.mock('$app/navigation', async () => (await import('./helpers/navigation')).navigationMock());
vi.mock('mode-watcher', () => ({ mode: { current: 'light' } }));

const silentSync = (): NotesSync => ({
	post() {},
	onRemoteChange: () => () => {},
	close() {}
});

let repository: NotesRepository;
let store: NotesStore;

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	resetNavigationMock();
	resetDeleteUndoForTests();
	toast.dismiss();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	repository = createNotesRepository({ sync: silentSync() });
	store = new NotesStore({ repository, sync: silentSync() });
});

afterEach(async () => {
	vi.useRealTimers();
	resetDeleteUndoForTests();
	toast.dismiss();
	store.dispose();
	await repository.close();
});

async function settle(rounds = 10): Promise<void> {
	for (let index = 0; index < rounds; index += 1) {
		await new Promise((resolve) => setImmediate(resolve));
		flushSync();
	}
}

const textbox = () => screen.getByRole('textbox', { name: 'Note' }) as HTMLTextAreaElement;

async function openEditorOn(id: string, active = true) {
	render(NoteList, {
		props: { store, activeNoteId: active ? id : null },
		context: notesStoreContext(store)
	});
	render(NoteEditor, { props: { noteId: id }, context: notesStoreContext(store) });
	render(Toaster);
	await settle();
}

describe('a note deleted while its save is still pending', () => {
	it('does not write into the removed record, so nothing goes into an error state', async () => {
		const created = await repository.createNote('original body');
		await store.load();
		await openEditorOn(created.id);

		const element = textbox();
		element.value = 'typed but not saved yet';
		await fireEvent.input(element);
		// Inside the debounce: nothing has been written for that text yet.
		await settle(2);

		// Delete the note from the list's "⋯ → Delete" while that save is pending.
		await fireEvent.click(screen.getByRole('button', { name: 'Note actions' }));
		await settle();
		await fireEvent.click(document.querySelector('[data-testid="note-row-delete"]') as HTMLElement);
		await settle();

		// Let the debounce that was already scheduled come due.
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 100);
		await settle(20);

		// The note stays gone: a stale write must never bring it back.
		expect(await repository.getNote(created.id)).toBeUndefined();
		expect(store.notes).toEqual([]);
		// And the doomed write never happened, so the store is healthy: the list
		// keeps showing its empty state instead of "Couldn't load your notes",
		// and the editor does not claim the text failed to save.
		expect(store.error).toBeNull();
		expect(store.status).toBe('ready');
		expect(document.querySelector('[data-testid="note-list-error"]')).toBeNull();
		expect(document.querySelector('[data-testid="editor-save-error"]')).toBeNull();
	});

	it('never resurrects the note, and stays healthy, when the delete lands mid-write', async () => {
		const created = await repository.createNote('original body');
		await store.load();
		await openEditorOn(created.id);

		// Hold the autosave's write open so the delete lands *while* it is
		// pending — the only ordering in which a stale write could re-create the
		// record after it was removed, or push the store into an error state.
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const realUpdate = repository.updateNote.bind(repository);
		const updateSpy = vi.spyOn(repository, 'updateNote').mockImplementation(async (id, body) => {
			await held;
			return realUpdate(id, body);
		});

		const element = textbox();
		element.value = 'typed and already being written';
		await fireEvent.input(element);
		// Let the debounce fire so the write itself starts before the delete.
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
		await settle(2);
		expect(updateSpy).toHaveBeenCalled();
		expect(store.notes.map((note) => note.id)).toEqual([created.id]);

		// Deleted from the list menu while that write is still open: this path
		// does not wait for the save, it deletes straight away.
		await fireEvent.click(screen.getByRole('button', { name: 'Note actions' }));
		await settle();
		await fireEvent.click(document.querySelector('[data-testid="note-row-delete"]') as HTMLElement);
		await settle();
		expect(await repository.getNote(created.id)).toBeUndefined();

		// Now the stale write finally runs, against a record that is gone.
		release();
		await settle(30);

		// It cannot bring the note back, and the failure is a lost race, not a
		// broken store: the list keeps its empty state instead of "Couldn't load
		// your notes".
		expect(await repository.getNote(created.id)).toBeUndefined();
		expect(store.notes).toEqual([]);
		expect(store.status).toBe('ready');
		expect(document.querySelector('[data-testid="note-list-error"]')).toBeNull();
		updateSpy.mockRestore();
	});
});
