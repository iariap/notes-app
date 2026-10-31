import { render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

const params = vi.hoisted(() => ({ id: 'some-id' }));
vi.mock('$app/state', () => ({ page: { params } }));
vi.mock('$app/navigation', async () => (await import('./helpers/navigation')).navigationMock());

import NotePage from '../../src/routes/notes/[id]/+page.svelte';
import { NotesStore } from '$lib/notes/notes.svelte';
import { notesStoreContext } from '$lib/notes/store-context';
import { createNotesRepository, type NotesRepository } from '$lib/notes/repository';
import type { NotesSync } from '$lib/notes/sync';
import { resetNavigationMock } from './helpers/navigation';

const silentSync = (): NotesSync => ({
	post() {},
	onRemoteChange: () => () => {},
	close() {}
});

let repository: NotesRepository | undefined;
let store: NotesStore | undefined;

/**
 * The route renders the real list and the real editor over real (in-memory)
 * storage, with the store the layout would have provided. The seeded note gets
 * a repository-generated id, so the URL's `some-id` deliberately does not match
 * it: that is how "the URL points at a note that is not stored" is covered
 * without mocking storage.
 */
beforeEach(async () => {
	globalThis.indexedDB = new IDBFactory();
	resetNavigationMock();
	const repo = createNotesRepository({ sync: silentSync() });
	repository = repo;
	await repo.createNote('# Some note\nfirst body');
	const created = new NotesStore({ repository: repo, sync: silentSync() });
	store = created;
	params.id = 'some-id';
});

afterEach(async () => {
	store?.dispose();
	await store?.repository.close();
	await repository?.close();
	store = undefined;
	repository = undefined;
});

function renderPage() {
	if (!store) throw new Error('store not initialised');
	return render(NotePage, { context: notesStoreContext(store) });
}

describe('note page', () => {
	it('highlights only the note in the URL with aria-current="page"', async () => {
		renderPage();

		// The list loads asynchronously; once it settles, the URL's id is current
		// only if that note exists. `some-id` does not (the repository generated
		// its own id), so nothing is marked.
		await screen.findByText('Some note');
		expect(screen.queryAllByRole('link', { current: 'page' })).toHaveLength(0);
	});

	it('says the note does not exist, with a way back to the list', async () => {
		renderPage();

		const missing = await screen.findByTestId('editor-missing');
		expect(missing).toHaveTextContent('This note doesn’t exist');

		const back = screen.getByRole('link', { name: 'Back to the list' });
		expect(back).toHaveAttribute('href', '/');
	});

	it('does not show the "New note" empty state while a note is open', async () => {
		renderPage();

		await screen.findByText('Some note');
		expect(screen.queryByText('No notes yet')).toBeNull();
	});
});

describe('note page with the note in storage', () => {
	it('marks the row whose id matches the URL', async () => {
		const repo = repository;
		if (!repo) throw new Error('repository not initialised');
		const stored = await repo.getNote('some-id');
		expect(stored).toBeUndefined();

		const all = await repo.listNotes();
		params.id = all[0].id;
		renderPage();

		const current = await screen.findAllByRole('link', { current: 'page' });
		expect(current).toHaveLength(1);
		expect(current[0]).toHaveAttribute('href', `/notes/${all[0].id}`);
		expect(current[0]).toHaveTextContent('Some note');
	});

	it('opens the stored body in the editor and shows the created date', async () => {
		const repo = repository;
		if (!repo) throw new Error('repository not initialised');
		const all = await repo.listNotes();
		params.id = all[0].id;
		renderPage();

		const textarea = await screen.findByRole('textbox', { name: 'Note' });
		expect(textarea).toHaveValue('# Some note\nfirst body');

		const date = await screen.findByTestId('editor-created-date');
		expect(date.textContent?.trim().length ?? 0).toBeGreaterThan(0);
	});
});
