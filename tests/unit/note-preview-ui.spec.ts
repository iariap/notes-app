import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import NoteEditor from '$lib/components/NoteEditor.svelte';
import { NotesStore } from '$lib/notes/notes.svelte';
import { createNotesRepository, type NotesRepository } from '$lib/notes/repository';
import { notesStoreContext } from '$lib/notes/store-context';
import type { NotesSync } from '$lib/notes/sync';
import { resetNavigationMock } from './helpers/navigation';

vi.mock('$app/navigation', async () => (await import('./helpers/navigation')).navigationMock());

/**
 * Live preview in the editor (issue #9).
 *
 * These cover the parts a unit test can honestly judge: that the preview
 * *renders* the note as HTML, that it updates while typing without stealing
 * focus, the caret or the scroll position, that the Edit/Preview tabs switch
 * panes, and that switching to Preview shows the text on screen immediately
 * rather than waiting out the debounce.
 *
 * The breakpoint itself (side-by-side at ≥ 1280 px, tabs below) is a CSS
 * question and is verified in Playwright against a real layout — jsdom has no
 * layout, so asserting it here would only test the class string.
 */

const silentSync = (): NotesSync => ({
	post() {},
	onRemoteChange: () => () => {},
	close() {}
});

let repository: NotesRepository | undefined;
let store: NotesStore | undefined;

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	resetNavigationMock();
	globalThis.sessionStorage?.clear();
	const repo = createNotesRepository({ sync: silentSync() });
	repository = repo;
	store = new NotesStore({ repository: repo, sync: silentSync() });
});

afterEach(async () => {
	vi.useRealTimers();
	store?.dispose();
	await store?.repository.close();
	await repository?.close();
	store = undefined;
	repository = undefined;
});

function currentStore(): NotesStore {
	if (!store) throw new Error('store not initialised');
	return store;
}

function currentRepository(): NotesRepository {
	if (!repository) throw new Error('repository not initialised');
	return repository;
}

function renderEditor(props: { noteId?: string | null } = {}) {
	return render(NoteEditor, { props, context: notesStoreContext(currentStore()) });
}

async function seed(body: string): Promise<string> {
	const created = await currentRepository().createNote(body);
	await currentStore().load();
	return created.id;
}

const textarea = () => screen.getByRole('textbox', { name: 'Note' }) as HTMLTextAreaElement;
const preview = () => screen.getByTestId('markdown-preview');

async function type(text: string): Promise<void> {
	const element = textarea();
	element.value = text;
	await fireEvent.input(element);
}

async function settle(rounds = 8): Promise<void> {
	for (let index = 0; index < rounds; index += 1) {
		await new Promise((resolve) => setImmediate(resolve));
		flushSync();
	}
}

async function until(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 80; attempt += 1) {
		if (predicate()) return;
		await settle(1);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`condition never held: ${message}`);
}

describe('the preview renders the note', () => {
	it('shows the stored Markdown as HTML, not as text', async () => {
		const id = await seed('# A heading\n\nsome **bold** words');
		renderEditor({ noteId: id });

		await until(() => screen.queryByTestId('markdown-preview') !== null, 'preview');
		await until(() => preview().querySelector('h1') !== null, 'rendered heading');

		expect(preview().querySelector('h1')?.textContent).toBe('A heading');
		expect(preview().querySelector('strong')?.textContent).toBe('bold');
		// The Markdown source is not shown verbatim: the asterisks are gone.
		expect(preview().textContent).not.toContain('**bold**');
	});

	it('says "Nothing to preview" for an empty note', async () => {
		renderEditor({ noteId: null });
		await settle();

		expect(screen.getByTestId('preview-empty')).toHaveTextContent('Nothing to preview');
		expect(screen.queryByTestId('markdown-preview')).toBeNull();
	});

	it('says "Nothing to preview" for whitespace only', async () => {
		renderEditor({ noteId: null });
		await settle();

		await type('   \n\n  ');
		await until(() => screen.queryByTestId('preview-empty') !== null, 'empty preview');
		expect(screen.queryByTestId('markdown-preview')).toBeNull();
	});
});

describe('the preview updates while typing', () => {
	it('re-renders after the debounce, without a save in between', async () => {
		const id = await seed('start');
		renderEditor({ noteId: id });
		await until(() => screen.queryByTestId('markdown-preview') !== null, 'preview');

		await type('# Typed heading');
		await until(() => preview().querySelector('h1')?.textContent === 'Typed heading', 'heading');

		// The note on disk is still untouched: the preview does not save.
		expect((await currentRepository().getNote(id))?.body).toBe('start');
	});

	it('coalesces a burst of keystrokes into a single final render', async () => {
		const id = await seed('seed');
		renderEditor({ noteId: id });
		await until(() => screen.queryByTestId('markdown-preview') !== null, 'preview');

		// Four keystrokes inside one debounce window: the preview must end on the
		// last one, and the intermediate states must not each become a render.
		await type('o');
		await type('on');
		await type('one');
		await type('one two');
		await until(() => preview()?.querySelector('p')?.textContent === 'one two', 'final text');
		expect(preview().querySelectorAll('p')).toHaveLength(1);
	});

	it('does not steal focus or move the caret', async () => {
		const id = await seed('abcdef');
		renderEditor({ noteId: id });
		await until(() => screen.queryByTestId('markdown-preview') !== null, 'preview');

		const element = textarea();
		element.focus();

		await type('abcdef plus more');
		// Placed *after* the input event, because assigning `value` in `type()`
		// moves the caret to the end on its own — the caret has to be planted at
		// the offset under test, then the preview is waited for.
		element.setSelectionRange(3, 3);

		await until(() => preview().textContent?.includes('plus more') === true, 'preview updated');

		// Same element, still focused, caret untouched: rendering HTML somewhere
		// else in the tree must not reach into the textarea.
		expect(textarea()).toBe(element);
		expect(document.activeElement).toBe(element);
		expect(element.selectionStart).toBe(3);
		expect(element.selectionEnd).toBe(3);
	});

	it('does not reset the preview scroll position while typing', async () => {
		// A long note, so the preview box can hold a scroll offset.
		const id = await seed(Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n'));
		renderEditor({ noteId: id });
		await until(() => screen.queryByTestId('markdown-preview') !== null, 'preview');

		const pane = screen.getByTestId('preview-pane');
		// jsdom has no layout, so the offset is whatever was assigned: the point is
		// that re-rendering does not write to it.
		pane.scrollTop = 120;

		await type(`${Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')}\nappended`);
		await until(() => preview().textContent?.includes('appended') === true, 'appended rendered');

		expect(pane.scrollTop).toBe(120);
	});

	it('keeps the Markdown source, never the rendered HTML, in storage', async () => {
		const id = await seed('# Title');
		renderEditor({ noteId: id });
		await until(() => screen.queryByTestId('markdown-preview') !== null, 'preview');

		await type('# Title\n\n- [ ] a task');
		await until(() => preview().querySelector('input') !== null, 'task list rendered');

		// Wait past the autosave debounce so the write has landed.
		await new Promise((resolve) => setTimeout(resolve, 600));
		await settle();

		const stored = await currentRepository().getNote(id);
		expect(stored?.body).toBe('# Title\n\n- [ ] a task');
		expect(stored?.body).not.toContain('<h1');
		expect(stored?.body).not.toContain('<input');
	});
});

describe('the Edit / Preview tabs', () => {
	it('start on Edit, with the tablist labelled', async () => {
		const id = await seed('# Hello');
		renderEditor({ noteId: id });
		await until(() => screen.queryByTestId('markdown-preview') !== null, 'preview');

		const tablist = screen.getByRole('tablist', { name: 'Editor view' });
		expect(tablist).toBeInTheDocument();
		expect(screen.getByRole('tab', { name: 'Edit' })).toHaveAttribute('aria-selected', 'true');
		expect(screen.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'false');
	});

	it('switches to Preview on click and back to Edit', async () => {
		const id = await seed('# Hello');
		renderEditor({ noteId: id });
		await until(() => screen.queryByTestId('markdown-preview') !== null, 'preview');

		await fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
		await settle();

		expect(screen.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true');
		expect(screen.getByTestId('preview-pane')).toHaveAttribute('role', 'tabpanel');

		await fireEvent.click(screen.getByRole('tab', { name: 'Edit' }));
		await settle();
		expect(screen.getByRole('tab', { name: 'Edit' })).toHaveAttribute('aria-selected', 'true');
	});

	it('shows the text on screen the moment Preview is selected', async () => {
		// The debounce is 120 ms; a switch must not wait it out. Typing and
		// switching in the same turn proves the flush rather than the timer.
		const id = await seed('start');
		renderEditor({ noteId: id });
		await until(() => screen.queryByTestId('markdown-preview') !== null, 'preview');

		await type('# Just typed');
		await fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
		await settle();

		expect(preview().querySelector('h1')?.textContent).toBe('Just typed');
	});

	it('remembers the chosen view for the session', async () => {
		const id = await seed('# Hello');
		const first = renderEditor({ noteId: id });
		await until(() => screen.queryByTestId('markdown-preview') !== null, 'preview');

		await fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
		await settle();
		first.unmount();

		// A fresh mount in the same session opens where the reader left it.
		renderEditor({ noteId: id });
		await until(
			() =>
				screen.queryByRole('tab', { name: 'Preview' })?.getAttribute('aria-selected') === 'true',
			'restored view'
		);
	});

	it('keeps the caret when returning to Edit', async () => {
		const id = await seed('# Hello');
		renderEditor({ noteId: id });
		await until(() => screen.queryByTestId('markdown-preview') !== null, 'preview');

		const element = textarea();
		element.focus();
		element.setSelectionRange(2, 2);

		await fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
		await settle();
		await fireEvent.click(screen.getByRole('tab', { name: 'Edit' }));
		await settle();

		// Same element and same selection: switching panes hides the editor, it
		// does not re-create it.
		expect(textarea()).toBe(element);
		expect(textarea().selectionStart).toBe(2);
	});
});

describe('hostile content in the preview', () => {
	it('renders a script payload inert', async () => {
		const id = await seed('<script>alert(1)</script>\n\n# Safe heading');
		renderEditor({ noteId: id });
		await until(() => screen.queryByTestId('markdown-preview') !== null, 'preview');
		await settle();

		expect(preview().querySelector('script')).toBeNull();
		expect(preview().textContent).not.toContain('alert(1)');
		expect(preview().querySelector('h1')?.textContent).toBe('Safe heading');
	});

	it('strips an onerror handler from an image', async () => {
		const id = await seed('<img src=x onerror=alert(1)>');
		renderEditor({ noteId: id });
		await until(() => screen.queryByTestId('markdown-preview') !== null, 'preview');

		expect(preview().innerHTML).not.toContain('onerror');
		expect(preview().querySelector('img')).not.toBeNull();
	});

	it('opens links in a new tab with noopener noreferrer', async () => {
		const id = await seed('[docs](https://example.com)');
		renderEditor({ noteId: id });
		await until(() => screen.queryByTestId('markdown-preview') !== null, 'preview');

		const link = preview().querySelector('a');
		expect(link).toHaveAttribute('target', '_blank');
		expect(link).toHaveAttribute('rel', 'noopener noreferrer');
	});
});

describe('autosave still works alongside the preview', () => {
	it('the preview debounce does not delay the autosave debounce', async () => {
		const id = await seed('start');
		renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		await type('typed with the preview mounted');
		// Autosave is 500 ms; the preview is shorter and must not interact with it.
		await new Promise((resolve) => setTimeout(resolve, 620));
		await until(
			() => screen.queryByTestId('editor-status')?.textContent === 'Saved',
			'saved status'
		);

		expect((await currentRepository().getNote(id))?.body).toBe('typed with the preview mounted');
	});

	it('a save failure still shows the alert while the preview is up', async () => {
		const id = await seed('start');
		renderEditor({ noteId: id });
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		vi.spyOn(currentStore(), 'updateNote').mockRejectedValueOnce(new Error('disk full'));
		await type('this will fail');
		await new Promise((resolve) => setTimeout(resolve, 620));
		await settle();

		expect(screen.getByTestId('editor-save-error')).toBeInTheDocument();
		expect(textarea()).toHaveValue('this will fail');
	});
});
