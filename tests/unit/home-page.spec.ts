import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Page from '../../src/routes/+page.svelte';

describe('home page', () => {
	it('renders the app name as a heading and a Button', () => {
		render(Page);

		expect(screen.getByRole('heading', { name: 'Notes' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'New note' })).toBeInTheDocument();
	});
});
