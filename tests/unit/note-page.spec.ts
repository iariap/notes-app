import { render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

const params = vi.hoisted(() => ({ id: 'some-id' }));
vi.mock('$app/state', () => ({ page: { params } }));

import NotePage from '../../src/routes/notes/[id]/+page.svelte';
import { createNotesRepository, type NotesRepository } from '$lib/notes/repository';
import type { NotesSync } from '$lib/notes/sync';

const silentSync = (): NotesSync => ({
	post() {},
	onRemoteChange: () => () => {},
	close() {}
});

let repository: NotesRepository | undefined;

/**
 * The route renders the real list over real (in-memory) storage. The seeded note
 * gets a repository-generated id, so the URL's `some-id` deliberately does not
 * match it: that is how "the URL points at a note that is not stored" is
 * covered without mocking anything.
 */
beforeEach(async () => {
	globalThis.indexedDB = new IDBFactory();
	const repo = createNotesRepository({ sync: silentSync() });
	repository = repo;
	await repo.createNote('# Some note\nfirst body');
	params.id = 'some-id';
});

describe('note page', () => {
	it('highlights only the note in the URL with aria-current="page"', async () => {
		render(NotePage);

		// The list loads asynchronously; once it settles, the URL's id is current
		// only if that note exists. `some-id` does not (the repository generated
		// its own id), so nothing is marked.
		await screen.findByText('Some note');
		expect(screen.queryAllByRole('link', { current: 'page' })).toHaveLength(0);
	});

	it('renders the editor placeholder instead of the empty-state hint', () => {
		render(NotePage);

		expect(screen.getByText('some-id')).toBeInTheDocument();
		expect(screen.queryByText('Select a note or create a new one')).not.toBeInTheDocument();
	});

	it('does not show the "New note" empty state while a note is open', async () => {
		render(NotePage);

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
		render(NotePage);

		const current = await screen.findAllByRole('link', { current: 'page' });
		expect(current).toHaveLength(1);
		expect(current[0]).toHaveAttribute('href', `/notes/${all[0].id}`);
		expect(current[0]).toHaveTextContent('Some note');
	});
});
