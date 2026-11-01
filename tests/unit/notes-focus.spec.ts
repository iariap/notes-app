import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { focusAfterRemoval, neighborId } from '$lib/components/notes-focus';

/**
 * `focusAfterRemoval` (#8): where focus goes once a note is deleted.
 *
 * The list and the editor call it after the record is already gone, which is
 * the moment the browser has dropped focus to `<body>` because the control the
 * user was on unmounted with the row. The function exists to catch exactly
 * that case — and *only* that case: a user who reached the Undo toast (or
 * anything else) in the frames the list was still re-reading storage keeps
 * their focus, because moving focus out of the toast would resume #8's 5 s
 * window and close it under them.
 *
 * These are DOM-level tests of the rule itself, with no Svelte component in
 * the way: the point is the decision, not the markup that triggers it.
 */

/** Rendered list markup: rows carry the ids and slots the function queries. */
function mountList(ids: readonly string[]): void {
	document.body.innerHTML = `
		<header><a href="/notes/new" data-testid="new-note">New note</a></header>
		<div data-slot="note-list">
			${ids
				.map((id) => `<a href="/notes/${id}" data-slot="note-row" data-note-id="${id}">${id}</a>`)
				.join('')}
		</div>
		<div data-sonner-toaster><button data-testid="undo">Undo</button></div>
	`;
}

const row = (id: string): HTMLElement =>
	document.querySelector<HTMLElement>(`[data-slot="note-row"][data-note-id="${id}"]`)!;

const undo = (): HTMLElement => document.querySelector<HTMLElement>('[data-testid="undo"]')!;

/** One animation frame: the unit the retry loop advances in. */
const frame = (): Promise<void> =>
	new Promise((resolve) => {
		requestAnimationFrame(() => resolve());
	});

/** Gives the retry loop every frame it is allowed to use. */
async function settleFrames(count = 12): Promise<void> {
	for (let index = 0; index < count; index += 1) await frame();
}

beforeEach(() => {
	document.body.innerHTML = '';
});

afterEach(() => {
	document.body.innerHTML = '';
});

describe('neighborId', () => {
	it('is the next note in list order, or the previous one for the last row', () => {
		const notes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
		expect(neighborId(notes, 'a')).toBe('b');
		expect(neighborId(notes, 'c')).toBe('b');
		expect(neighborId([{ id: 'only' }], 'only')).toBeNull();
		expect(neighborId(notes, 'gone')).toBeNull();
	});
});

describe('focusAfterRemoval', () => {
	it('moves focus to the neighbouring row when the removal left it on <body>', () => {
		mountList(['a', 'b', 'c']);
		// What a delete leaves behind: the focused control unmounted with its row,
		// so the browser has already dropped focus to the document body.
		expect(document.activeElement).toBe(document.body);

		focusAfterRemoval('b');

		expect(document.activeElement).toBe(row('b'));
	});

	it('never takes focus away from an element the user already focused', async () => {
		mountList(['a', 'b', 'c']);
		// A keyboard user who reached the Undo action while the list was settling.
		undo().focus();
		expect(document.activeElement).toBe(undo());

		focusAfterRemoval('b');

		expect(document.activeElement).toBe(undo());
		// Not just on the first attempt: the retries must not take it either.
		await settleFrames();
		expect(document.activeElement).toBe(undo());
	});

	it('keeps giving up while the list is still loading, if focus arrived meanwhile', async () => {
		// The skeleton case: the row is not on screen yet, so the loop retries.
		mountList([]);
		undo().focus();

		focusAfterRemoval('b');
		// The rows arrive while the loop is still waiting for them.
		mountList(['a', 'b', 'c']);
		undo().focus();

		await settleFrames();
		expect(document.activeElement).toBe(undo());
	});

	it('still waits for a row that is not on screen yet', async () => {
		// Why the loop exists at all: the list re-reads storage after a write and
		// renders its skeleton in the meantime. Focus must land on the row once it
		// is there, not be dropped on <body> in the gap.
		mountList([]);
		expect(document.activeElement).toBe(document.body);

		focusAfterRemoval('b');
		expect(document.activeElement).toBe(document.body);

		await frame();
		mountList(['a', 'b', 'c']);

		await settleFrames();
		expect(document.activeElement).toBe(row('b'));
	});

	it('falls back to the first row, then to "New note" once the list is empty', async () => {
		mountList(['a', 'b']);
		// Unknown id (the neighbour was deleted from another tab, say): first row.
		focusAfterRemoval('gone');
		expect(document.activeElement).toBe(row('a'));

		mountList([]);
		(document.activeElement as HTMLElement | null)?.blur();
		focusAfterRemoval('gone');

		// The header entry point is only used once the list is settled and truly
		// empty, which is what the last retry is for.
		await settleFrames();
		expect(document.activeElement).toBe(document.querySelector('[data-testid="new-note"]'));
	});
});
