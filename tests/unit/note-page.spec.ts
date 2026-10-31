import { render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const params = vi.hoisted(() => ({ id: 'some-id' }));
vi.mock('$app/state', () => ({ page: { params } }));

import NotePage from '../../src/routes/notes/[id]/+page.svelte';

describe('note page', () => {
	beforeEach(() => {
		params.id = 'some-id';
	});

	it('highlights the matching list item with aria-current="page"', () => {
		render(NotePage);

		const current = screen.getAllByRole('link', { current: 'page' });
		expect(current).toHaveLength(1);
		expect(current[0]).toHaveAttribute('href', '/notes/some-id');
		expect(current[0]).toHaveTextContent('Placeholder note 1');
	});

	it('renders the editor placeholder instead of the empty-state hint', () => {
		render(NotePage);

		expect(screen.getByText('some-id')).toBeInTheDocument();
		expect(screen.queryByText('Select a note or create a new one')).not.toBeInTheDocument();
	});

	it('highlights only the note in the URL', () => {
		params.id = 'third-note';
		render(NotePage);

		const current = screen.getAllByRole('link', { current: 'page' });
		expect(current).toHaveLength(1);
		expect(current[0]).toHaveTextContent('Placeholder note 3');
	});
});
