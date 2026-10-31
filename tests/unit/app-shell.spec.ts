import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { createRawSnippet } from 'svelte';
import AppShell from '../../src/lib/components/AppShell.svelte';

const text = (value: string) => createRawSnippet(() => ({ render: () => `<p>${value}</p>` }));

describe('AppShell', () => {
	it('renders both panes regardless of the mobile pane', () => {
		render(AppShell, {
			props: { mobilePane: 'list', list: text('list content'), editor: text('editor content') }
		});

		const list = screen.getByRole('region', { name: 'Notes' });
		const editor = screen.getByRole('region', { name: 'Note editor' });

		expect(list).toHaveTextContent('list content');
		expect(editor).toHaveTextContent('editor content');
	});

	it('gives the single mobile column to the list on /', () => {
		render(AppShell, {
			props: { mobilePane: 'list', list: text('list content'), editor: text('editor content') }
		});

		const list = screen.getByRole('region', { name: 'Notes' });
		const editor = screen.getByRole('region', { name: 'Note editor' });

		expect(list).toHaveClass('flex');
		expect(list).toHaveClass('md:flex');
		expect(editor).toHaveClass('hidden');
		expect(editor).toHaveClass('md:flex');
	});

	it('gives the single mobile column to the editor on /notes/*', () => {
		render(AppShell, {
			props: { mobilePane: 'editor', list: text('list content'), editor: text('editor content') }
		});

		const list = screen.getByRole('region', { name: 'Notes' });
		const editor = screen.getByRole('region', { name: 'Note editor' });

		expect(list).toHaveClass('hidden');
		expect(list).toHaveClass('md:flex');
		expect(editor).toHaveClass('flex');
		expect(editor).toHaveClass('md:flex');
	});

	it('gives each pane its own scroll area and the sidebar a fixed md width', () => {
		render(AppShell, {
			props: { mobilePane: 'list', list: text('list content'), editor: text('editor content') }
		});

		const list = screen.getByRole('region', { name: 'Notes' });
		const editor = screen.getByRole('region', { name: 'Note editor' });

		expect(list.querySelector('[data-slot="scroll-area"]')).not.toBeNull();
		expect(editor.querySelector('[data-slot="scroll-area"]')).not.toBeNull();
		expect(list).toHaveClass('md:w-80');
	});
});
