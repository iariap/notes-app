import { render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import Page from '../../src/routes/+page.svelte';
import { NotesStore } from '$lib/notes/notes.svelte';
import { notesStoreContext } from '$lib/notes/store-context';
import type { NotesSync } from '$lib/notes/sync';

/**
 * The list route, mounted without the layout — so it gets the store the layout
 * would have provided, injected as Svelte context. That is the same key the app
 * uses; a second instance here would defeat the point of the shared store.
 */
const silentSync = (): NotesSync => ({
	post() {},
	onRemoteChange: () => () => {},
	close() {}
});

let store: NotesStore | undefined;

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	const created = new NotesStore({ sync: silentSync() });
	store = created;
});

afterEach(async () => {
	store?.dispose();
	await store?.repository.close();
	store = undefined;
});

function renderHome() {
	if (!store) throw new Error('store not initialised');
	return render(Page, { context: notesStoreContext(store) });
}

describe('home page', () => {
	it('renders the list region and the empty-editor hint', () => {
		renderHome();

		expect(screen.getByRole('region', { name: 'Notes' })).toBeInTheDocument();
		expect(screen.getByText('Select a note or create a new one')).toBeInTheDocument();
	});

	it('shows the empty state instead of placeholder rows', async () => {
		renderHome();

		expect(await screen.findByText('No notes yet')).toBeInTheDocument();
		expect(screen.queryByText('Notes list placeholder')).toBeNull();
	});

	it('marks no list item as the current page', async () => {
		renderHome();

		await screen.findByText('No notes yet');
		expect(screen.queryAllByRole('link', { current: 'page' })).toHaveLength(0);
	});
});
