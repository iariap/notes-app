import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import Page from '../../src/routes/+page.svelte';

/**
 * The list reads storage on mount (`NotesStore.load()`), so every render needs
 * a fresh in-memory IndexedDB: a shared one would carry notes between tests.
 */
function renderHome() {
	globalThis.indexedDB = new IDBFactory();
	return render(Page);
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
