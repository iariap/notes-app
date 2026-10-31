import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { createRawSnippet } from 'svelte';
import AppHeader from '../../src/lib/components/AppHeader.svelte';

const snippet = (html: string) => createRawSnippet(() => ({ render: () => html }));

describe('AppHeader', () => {
	it('always offers the "New note" action, with the same accessible name', () => {
		render(AppHeader);

		const newNote = screen.getByRole('link', { name: 'New note' });
		expect(newNote).toHaveAttribute('href', '/notes/new');
		// The label is hidden below `md`: the accessible name comes from
		// `aria-label`, so it does not change with the breakpoint.
		expect(newNote).toHaveAttribute('aria-label', 'New note');
		expect(newNote.querySelector('span')?.className).toContain('hidden');
		expect(newNote.querySelector('span')?.className).toContain('md:inline');
	});

	it('keeps the action at least 44 px tall on every viewport', () => {
		render(AppHeader);

		expect(screen.getByRole('link', { name: 'New note' }).className).toContain('min-h-11');
	});

	it('hides the back link by default and shows it on request', () => {
		const { unmount } = render(AppHeader);
		expect(screen.queryByRole('link', { name: 'Back to notes' })).toBeNull();
		unmount();

		render(AppHeader, { props: { showBack: true } });
		const back = screen.getByRole('link', { name: 'Back to notes' });
		expect(back).toHaveAttribute('href', '/');
	});

	it('renders the page actions snippet alongside the New note action', () => {
		render(AppHeader, { props: { actions: snippet('<button>Page action</button>') } });

		expect(screen.getByRole('button', { name: 'Page action' })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'New note' })).toBeInTheDocument();
	});
});
