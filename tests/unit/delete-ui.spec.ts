import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import NoteEditor from '$lib/components/NoteEditor.svelte';
import NoteList from '$lib/components/NoteList.svelte';
import { Toaster } from '$lib/components/ui/sonner/index.js';
import { UNDO_WINDOW_MS, resetDeleteUndoForTests } from '$lib/notes/delete-undo';
import { NotesStore } from '$lib/notes/notes.svelte';
import { createNotesRepository, type NotesRepository } from '$lib/notes/repository';
import { notesStoreContext } from '$lib/notes/store-context';
import type { NotesSync } from '$lib/notes/sync';
import type { Note } from '$lib/notes/types';
import { toast } from 'svelte-sonner';
import { navigationHarness, resetNavigationMock } from './helpers/navigation';

vi.mock('$app/navigation', async () => (await import('./helpers/navigation')).navigationMock());

/**
 * `svelte-sonner`'s shadcn wrapper reads `mode-watcher`, whose module-level state
 * touches `localStorage` at import time — which this Node runtime only exposes
 * with an experimental flag. The toaster's *behaviour* is what this file tests,
 * not the colour theme, so the mode is pinned instead of standing up storage for
 * a value the assertions never read.
 */
vi.mock('mode-watcher', () => ({ mode: { current: 'light' } }));

/**
 * #8 delete from the two entry points, exercised through the *real* toaster.
 *
 * `tests/unit/delete-undo.spec.ts` proves the storage contract with an injected
 * notifier; this file proves the wiring a user actually touches: the editor's
 * Delete button and the row's "⋯ → Delete" reach `deleteNote`, the toast lands
 * in the DOM with a usable Undo button, and the note comes back in its slot.
 *
 * Real storage, real store and real `svelte-sonner`. `setTimeout`, `Date` and
 * the `[data-sonner-toaster]` focus listeners are all real too — the 5 s window
 * is *not* faked here, because the point of this file is that the deadline set
 * by the shipped code is the one the DOM obeys. Only the autosave debounce is
 * advanced by hand.
 *
 * The row menu is opened and its Delete item clicked through the DOM node
 * rather than `getByRole`: bits-ui positions its content with a floating layer,
 * and jsdom has no layout, so the menu is rendered `visibility: hidden`. The
 * markup, roles and labels are asserted on the node; the click is real.
 */

const silentSync = (): NotesSync => ({
	post() {},
	onRemoteChange: () => () => {},
	close() {}
});

let repository: NotesRepository;
let store: NotesStore;
let clock = Date.parse('2026-10-31T13:13:00.000Z');
const navigation = navigationHarness();

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	resetNavigationMock();
	resetDeleteUndoForTests();
	toast.dismiss();
	clock = Date.parse('2026-10-31T13:13:00.000Z');
	repository = createNotesRepository({
		sync: silentSync(),
		// One minute per write, so list order is known without sleeping and the
		// order is stable across the delete and the restore.
		now: () => {
			const date = new Date(clock);
			clock += 60_000;
			return date;
		}
	});
	store = new NotesStore({ repository, sync: silentSync() });
});

afterEach(() => {
	resetDeleteUndoForTests();
	toast.dismiss();
	store.dispose();
});

/** Lets IndexedDB's real macrotasks and Svelte's effects run. */
async function settle(rounds = 12): Promise<void> {
	for (let index = 0; index < rounds; index += 1) {
		await new Promise((resolve) => setImmediate(resolve));
		flushSync();
	}
}

/** Polls `predicate`, letting macrotasks and real timers (incl. animation frames) run. */
async function until(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (predicate()) return;
		await settle(1);
		// A frame's worth of real time: the focus hand-off retries on
		// `requestAnimationFrame`, which `setImmediate` alone would never reach.
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`condition never held: ${message}`);
}

async function seed(body: string): Promise<Note> {
	const created = await repository.createNote(body);
	await store.load();
	return created;
}

const storedIds = () => store.notes.map((note) => note.id);

/** The toast title node, as a user and a screen reader find it. */
const toastTitle = () => document.querySelector('[data-sonner-toast] [data-title]');

function undoButton(): HTMLElement | null {
	return document.querySelector('[data-sonner-toast] [data-button]');
}

describe('editor Delete button', () => {
	it('deletes immediately, shows the Undo toast and leaves for the list', async () => {
		const note = await seed('A note that goes');
		render(NoteEditor, { props: { noteId: note.id }, context: notesStoreContext(store) });
		render(Toaster);
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		const button = screen.getByRole('button', { name: 'Delete note' });
		// Icon-only below `md`, with the visible label from `md` up: one
		// accessible name at every width, and a ≥44 px target either way.
		expect(button).toHaveAccessibleName('Delete note');
		expect(button.className).toContain('min-h-11');
		expect(button.className).toContain('min-w-11');
		expect(button.querySelector('span')?.className).toContain('hidden');
		expect(button.querySelector('span')?.className).toContain('md:inline');

		await fireEvent.click(button);
		await settle();

		// Gone from storage straight away, before anything else is asserted.
		expect(await repository.getNote(note.id)).toBeUndefined();
		expect(storedIds()).toEqual([]);
		// Announced through the toaster, with the Undo affordance in the DOM.
		await until(() => toastTitle()?.textContent === 'Note deleted', 'delete toast');
		expect(undoButton()?.textContent).toBe('Undo');
		// Leaving is part of deleting, on every width.
		expect(navigation.replacements()).toContain('goto:/');
	});

	it('Undo restores the identical record into the same slot', async () => {
		const first = await seed('First');
		const middle = await seed('Second');
		const last = await seed('Third');
		await store.load();
		render(NoteList, { props: { store }, context: notesStoreContext(store) });
		render(NoteEditor, { props: { noteId: middle.id }, context: notesStoreContext(store) });
		render(Toaster);
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		const before = storedIds();
		expect(before).toEqual([last.id, middle.id, first.id]);

		await fireEvent.click(screen.getByRole('button', { name: 'Delete note' }));
		await settle();
		await until(() => undoButton() !== null, 'undo button');

		await fireEvent.click(undoButton() as HTMLElement);
		await settle();

		// The identical record: same id, body and both dates.
		expect(await repository.getNote(middle.id)).toEqual(middle);
		// Which is why it lands in the same position: `updatedAt` is the sort key.
		expect(storedIds()).toEqual(before);
	});

	it('expires after 5 s: the toast goes and Undo can no longer bring it back', async () => {
		const note = await seed('Temporary');
		render(NoteEditor, { props: { noteId: note.id }, context: notesStoreContext(store) });
		render(Toaster);
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		await fireEvent.click(screen.getByRole('button', { name: 'Delete note' }));
		await settle();
		await until(() => undoButton() !== null, 'undo button');

		// Real time: the window the module opened is the one that closes it.
		await new Promise((resolve) => setTimeout(resolve, UNDO_WINDOW_MS + 400));
		await settle();

		await until(() => toastTitle() === null, 'toast gone');
		expect(undoButton()).toBeNull();
		expect(await repository.getNote(note.id)).toBeUndefined();
	}, 15_000);

	it('flushes text typed inside the debounce window before deleting, so Undo keeps it', async () => {
		const note = await seed('Saved body');
		render(NoteEditor, { props: { noteId: note.id }, context: notesStoreContext(store) });
		render(Toaster);
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		const textarea = screen.getByRole('textbox', { name: 'Note' }) as HTMLTextAreaElement;
		textarea.value = 'Saved body plus the words I just typed';
		await fireEvent.input(textarea);
		// No autosave has fired yet (it waits 500 ms): deleting must not lose this.
		await fireEvent.click(screen.getByRole('button', { name: 'Delete note' }));
		await settle();
		await until(() => undoButton() !== null, 'undo button');

		await fireEvent.click(undoButton() as HTMLElement);
		await settle();

		const restored = await repository.getNote(note.id);
		expect(restored?.body).toBe('Saved body plus the words I just typed');
		// The created date is the original one: restoring is not creating.
		expect(restored?.createdAt).toBe(note.createdAt);
		// `updatedAt` *did* move — the flush before the delete is a real save — but
		// it is the value captured at delete time, not a new one on restore: the
		// record comes back exactly as it was removed.
		expect(restored?.updatedAt).not.toBe(note.updatedAt);
		expect(restored?.updatedAt).toBe(note.createdAt.replace('13:13', '13:14'));
	});
});

describe('list row menu', () => {
	/**
	 * Opens the "⋯" menu and returns its Delete item node.
	 *
	 * The press is a click because the row's trigger mounts the menu on its
	 * first activation (see `NoteListRow`): a keyboard Enter press on a `<button>`
	 * lands as a click, so this is the same path a user takes.
	 *
	 * The item is found through the DOM rather than `getByRole`: bits-ui positions
	 * the content with a floating layer, and jsdom has no layout, so the menu
	 * renders `visibility: hidden`. Its role, name and destructive styling are
	 * asserted separately, which is what the accessibility contract is about.
	 * Real pointer and keyboard use of the menu is covered by the E2E spec.
	 */
	async function openDeleteItem(trigger: HTMLElement): Promise<HTMLElement> {
		trigger.focus();
		await fireEvent.click(trigger);
		await settle();
		const item = document.querySelector<HTMLElement>('[data-testid="note-row-delete"]');
		expect(item).not.toBeNull();
		return item as HTMLElement;
	}

	it('offers Delete behind the "⋯" menu and deletes through it', async () => {
		const note = await seed('Deletable from the list');
		render(NoteList, { props: { store }, context: notesStoreContext(store) });
		render(Toaster);
		await until(() => screen.queryByText('Deletable from the list') !== null, 'row');

		const trigger = screen.getByRole('button', { name: 'Note actions' });
		// A full 44 px target on every device.
		expect(trigger.className).toContain('size-11');
		expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
		// Always visible with a finger (no hover), revealed on hover or focus of
		// the row with a mouse. Opacity only, so it stays in the tab order.
		const wrapper = trigger.parentElement as HTMLElement;
		expect(wrapper.className).toContain('pointer-coarse:opacity-100');
		expect(wrapper.className).toContain('group-hover/row:opacity-100');
		expect(wrapper.className).toContain('focus-within:opacity-100');
		expect(wrapper.className).toContain('opacity-0');

		const item = await openDeleteItem(trigger);
		expect(item).toHaveAttribute('role', 'menuitem');
		expect(item.textContent?.trim()).toBe('Delete');
		expect(item).toHaveAttribute('data-variant', 'destructive');

		await fireEvent.click(item);
		await settle();

		expect(await repository.getNote(note.id)).toBeUndefined();
		expect(store.notes).toEqual([]);
		await until(() => toastTitle()?.textContent === 'Note deleted', 'delete toast');
	});

	it('moves focus to the neighbouring row instead of losing it', async () => {
		const first = await seed('Row one');
		const middle = await seed('Row two');
		const last = await seed('Row three');
		await store.load();
		render(NoteList, { props: { store }, context: notesStoreContext(store) });
		await until(() => screen.queryByText('Row two') !== null, 'rows');

		// Newest first: `last`, `middle`, `first`. Deleting the middle row must
		// leave focus on its successor, `first`.
		expect(storedIds()).toEqual([last.id, middle.id, first.id]);
		const triggers = screen.getAllByRole('button', { name: 'Note actions' });
		await fireEvent.click(await openDeleteItem(triggers[1]));
		await settle();

		expect(await repository.getNote(middle.id)).toBeUndefined();
		// The list re-reads storage after the write, so the surviving rows are
		// briefly off screen; focus lands once the successor is rendered.
		await until(
			() =>
				document.activeElement ===
				document.querySelector(`[data-slot="note-row"][data-note-id="${first.id}"]`),
			'focus on the neighbouring row'
		);
		expect((await repository.getNote(last.id))?.id).toBe(last.id);
	});

	it('does not claim the note was deleted in another tab, in this tab', async () => {
		const note = await seed('Mine to delete');
		render(NoteList, {
			props: { store, activeNoteId: note.id },
			context: notesStoreContext(store)
		});
		render(NoteEditor, { props: { noteId: note.id }, context: notesStoreContext(store) });
		render(Toaster);
		await until(() => screen.queryByText('Mine to delete') !== null, 'row');
		await until(() => screen.queryByRole('textbox', { name: 'Note' }) !== null, 'textarea');

		const trigger = screen.getByRole('button', { name: 'Note actions' });
		await fireEvent.click(await openDeleteItem(trigger));
		await settle();

		// The editor was on the deleted note and this tab did it, so #7's message
		// about *another* tab must never appear — not even for one frame before
		// the editor navigates away.
		expect(screen.queryByTestId('editor-deleted')).toBeNull();
		await until(() => navigation.replacements().includes('goto:/'), 'left the note');
		expect(screen.queryByTestId('editor-deleted')).toBeNull();
	});
});
