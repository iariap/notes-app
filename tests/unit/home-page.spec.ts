import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Page from '../../src/routes/+page.svelte';

describe('home page', () => {
	it('renders the list placeholder and the empty-editor hint', () => {
		render(Page);

		expect(screen.getByRole('region', { name: 'Notes' })).toBeInTheDocument();
		expect(screen.getByText('Notes list placeholder')).toBeInTheDocument();
		expect(screen.getByText('Select a note or create a new one')).toBeInTheDocument();
	});

	it('marks no list item as the current page', () => {
		render(Page);

		expect(screen.queryAllByRole('link', { current: 'page' })).toHaveLength(0);
	});
});
