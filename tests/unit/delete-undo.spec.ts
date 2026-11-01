import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import type { ExternalToast } from 'svelte-sonner';
import { toast } from 'svelte-sonner';
import {
	DELETE_TOAST_MESSAGE,
	UNDO_ACTION_LABEL,
	UNDO_WINDOW_MS,
	deleteNoteWithUndo,
	finalizeAllUndoWindows,
	resetDeleteUndoForTests,
	wasDeletedInThisTab,
	type ToastNotifier
} from '$lib/notes/delete-undo';
import { NotesStore } from '$lib/notes/notes.svelte';
import { createNotesRepository, type NotesRepository } from '$lib/notes/repository';
import type { NotesSync } from '$lib/notes/sync';
import { NoteMissingError, StorageFullError, type Note } from '$lib/notes/types';

/**
 * #8 delete + Undo, against real storage.
 *
 * The promises this issue makes are about *storage*: the record is gone at once,
 * and Undo puts back the identical record — same id, body and both dates — so it
 * lands in the same list position. IndexedDB under `fake-indexeddb` is the only
 * way to assert that; a mocked store would only assert the mock.
 *
 * Only `setTimeout`/`clearTimeout`/`Date` are faked, so the 5 s window is
 * advanced instantly while IndexedDB keeps its own real scheduling.
 */

const T0 = Date.parse('2026-10-31T13:13:00.000Z');

const silentSync = (): NotesSync => ({
	post() {},
	onRemoteChange: () => () => {},
	close() {}
});

/** Records what the module asked the toaster to do, and hands back the data. */
interface SentToast {
	message: string;
	data: ExternalToast;
}

interface FakeToaster extends ToastNotifier {
	sent: SentToast[];
	dismissed: (string | number | undefined)[];
}

function fakeToaster(): FakeToaster {
	const sent: SentToast[] = [];
	const dismissed: (string | number | undefined)[] = [];
	const notify = vi.fn((message: string, data?: ExternalToast) => {
		sent.push({ message, data: data ?? {} });
		return data?.id ?? sent.length;
	});
	const dismiss = vi.fn((id?: string | number) => {
		dismissed.push(id);
	});
	// One object: the module takes the notifier whole, so `dismiss` travels with
	// the callable instead of being patched onto it.
	return Object.assign(notify, { dismiss, sent, dismissed });
}

/**
 * Presses a sent toast's action the way sonner does.
 *
 * `ExternalToast.action` is either that shape or a bare component, so the union
 * has to be narrowed before the click; doing it here keeps every test reading
 * as "the user pressed Undo" instead of repeating the narrowing at each site.
 */
function pressUndo(data: ExternalToast): void {
	const action = data.action;
	if (action === undefined || typeof action === 'function') {
		throw new Error('the toast has no action to press');
	}
	// The handler's parameter is sonner's own event type; a real click on the
	// button is what E2E does, and here only its invocation matters.
	action.onClick(new MouseEvent('click') as Parameters<typeof action.onClick>[0]);
}

let repository: NotesRepository;
let store: NotesStore;

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
	resetDeleteUndoForTests();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	vi.setSystemTime(new Date(T0));
	repository = createNotesRepository({
		sync: silentSync(),
		now: () => new Date(Date.parse(new Date().toISOString())),
		// Deterministic ids and a clock that advances per write, so list order is
		// known without sleeping.
		createId: () => `note-${String((idCounter += 1)).padStart(4, '0')}`
	});
	store = new NotesStore({ repository, sync: silentSync() });
});

let idCounter = 0;

afterEach(async () => {
	vi.useRealTimers();
	resetDeleteUndoForTests();
	store.dispose();
	await repository.close();
});

/** Lets IndexedDB's real macrotasks run without moving the fake clock. */
async function settle(rounds = 10): Promise<void> {
	for (let index = 0; index < rounds; index += 1) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

/** Seeds three notes a minute apart and loads the store. */
async function seedThree(): Promise<Note[]> {
	const created: Note[] = [];
	for (const body of ['First note', 'Second note', 'Third note']) {
		created.push(await store.createNote(body));
		vi.setSystemTime(new Date(Date.parse(new Date().toISOString()) + 60_000));
	}
	await store.load();
	return created;
}

const storedIds = () => store.notes.map((note) => note.id);

describe('deleting immediately', () => {
	it('removes the record from storage and from the list before any Undo', async () => {
		const [, middle] = await seedThree();
		const toaster = fakeToaster();

		await deleteNoteWithUndo(store, middle.id, { notify: toaster });

		expect(await repository.getNote(middle.id)).toBeUndefined();
		expect(storedIds()).not.toContain(middle.id);
		expect(store.notes).toHaveLength(2);
	});

	it('shows "Note deleted" with an Undo action, for the full 5 s', async () => {
		const [note] = await seedThree();
		const toaster = fakeToaster();

		await deleteNoteWithUndo(store, note.id, { notify: toaster });

		expect(toaster.sent).toHaveLength(1);
		const [{ message, data }] = toaster.sent;
		expect(message).toBe(DELETE_TOAST_MESSAGE);
		expect(message).toBe('Note deleted');
		const action = data.action;
		expect(action !== undefined && typeof action !== 'function' && 'label' in action).toBe(true);
		if (action !== undefined && typeof action !== 'function' && 'label' in action) {
			expect(action.label).toBe(UNDO_ACTION_LABEL);
		}
		expect(UNDO_ACTION_LABEL).toBe('Undo');
		// Our timer owns the deadline (see the module comment), so the toast
		// itself must never auto-close early.
		expect(data.duration).toBe(Number.POSITIVE_INFINITY);
		expect(UNDO_WINDOW_MS).toBe(5000);
	});
});

describe('undo restores the identical record', () => {
	it('puts back the same id, body, createdAt and updatedAt', async () => {
		const [, middle] = await seedThree();
		const toaster = fakeToaster();

		await deleteNoteWithUndo(store, middle.id, { notify: toaster });
		pressUndo(toaster.sent[0].data);
		await settle();

		expect(await repository.getNote(middle.id)).toEqual(middle);
		// Not merely equal fields: the same list slot, because `updatedAt` is the
		// sort key and it came back untouched.
		expect(store.notes.map((note) => note.id)).toContain(middle.id);
		expect(store.notes.find((note) => note.id === middle.id)).toEqual(middle);
	});

	it('restores to the same position in the list', async () => {
		const [first, middle, last] = await seedThree();
		const toaster = fakeToaster();
		const before = storedIds();
		expect(before).toEqual([last.id, middle.id, first.id]);

		await deleteNoteWithUndo(store, middle.id, { notify: toaster });
		expect(storedIds()).toEqual([last.id, first.id]);

		pressUndo(toaster.sent[0].data);
		await settle();

		expect(storedIds()).toEqual(before);
	});

	it('keeps the created date, so the row shows the original age', async () => {
		const [note] = await seedThree();
		const toaster = fakeToaster();

		await deleteNoteWithUndo(store, note.id, { notify: toaster });
		// Days pass inside the window: a restored record must not look new.
		vi.setSystemTime(new Date(Date.parse(note.createdAt) + 3 * 24 * 60 * 60_000));
		pressUndo(toaster.sent[0].data);
		await settle();

		expect((await repository.getNote(note.id))?.createdAt).toBe(note.createdAt);
	});

	it('survives a reload: the record is really back in storage', async () => {
		const [, middle] = await seedThree();
		const toaster = fakeToaster();

		await deleteNoteWithUndo(store, middle.id, { notify: toaster });
		pressUndo(toaster.sent[0].data);
		await settle();

		// A fresh store over the same database: nothing kept in memory.
		const reopened = new NotesStore({ repository, sync: silentSync() });
		await reopened.load();
		expect(reopened.notes.find((note) => note.id === middle.id)).toEqual(middle);
		expect(reopened.notes.map((note) => note.id)).toEqual([...storedIds()]);
		reopened.dispose();
	});

	it('dismisses its toast once the note is back', async () => {
		const [note] = await seedThree();
		const toaster = fakeToaster();

		await deleteNoteWithUndo(store, note.id, { notify: toaster });
		const toastId = toaster.sent[0].data.id;
		pressUndo(toaster.sent[0].data);
		await settle();

		expect(toaster.dismissed).toEqual([toastId]);
	});
});

describe('the window ends', () => {
	it('after 5 s: Undo is inert and the deletion is final', async () => {
		const [, middle] = await seedThree();
		const toaster = fakeToaster();

		await deleteNoteWithUndo(store, middle.id, { notify: toaster });
		await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS - 1);
		await settle();
		// One millisecond early: the window is still open.
		expect(toaster.dismissed).toEqual([]);

		await vi.advanceTimersByTimeAsync(1);
		await settle();
		// Expired: the toast went away by itself.
		expect(toaster.dismissed).toEqual([toaster.sent[0].data.id]);

		// A late click must not bring the note back.
		pressUndo(toaster.sent[0].data);
		await settle();
		expect(await repository.getNote(middle.id)).toBeUndefined();
		expect(storedIds()).not.toContain(middle.id);
	});

	it('on pagehide, immediately', async () => {
		const [note] = await seedThree();
		const toaster = fakeToaster();

		await deleteNoteWithUndo(store, note.id, { notify: toaster });
		// Still well inside the 5 s.
		await vi.advanceTimersByTimeAsync(100);
		window.dispatchEvent(new Event('pagehide'));
		await settle();

		expect(toaster.dismissed).toEqual([toaster.sent[0].data.id]);
		pressUndo(toaster.sent[0].data);
		await settle();
		expect(await repository.getNote(note.id)).toBeUndefined();
	});

	it('when another delete starts, without stealing the older window', async () => {
		const [first, , last] = await seedThree();
		const toaster = fakeToaster();

		await deleteNoteWithUndo(store, first.id, { notify: toaster });
		await vi.advanceTimersByTimeAsync(4000);
		await deleteNoteWithUndo(store, last.id, { notify: toaster });

		// The second delete gets its own toast, with its own id.
		expect(toaster.sent).toHaveLength(2);
		expect(toaster.sent[0].data.id).not.toBe(toaster.sent[1].data.id);

		// 1 s later the first window closes; the second still has 4 s left.
		await vi.advanceTimersByTimeAsync(1000);
		await settle();
		expect(toaster.dismissed).toEqual([toaster.sent[0].data.id]);

		pressUndo(toaster.sent[1].data);
		await settle();
		expect(await repository.getNote(last.id)).toBeDefined();
		expect(await repository.getNote(first.id)).toBeUndefined();
	});

	it('when the toast is dismissed by the user', async () => {
		const [note] = await seedThree();
		const toaster = fakeToaster();

		await deleteNoteWithUndo(store, note.id, { notify: toaster });
		// Sonner reports a swipe / close button through `onDismiss`.
		toaster.sent[0].data.onDismiss?.({ id: 1, type: 'default' });
		pressUndo(toaster.sent[0].data);
		await settle();

		expect(await repository.getNote(note.id)).toBeUndefined();
	});
});

describe('two quick deletes undo independently', () => {
	it('each Undo restores only its own note, never the other', async () => {
		const [first, middle, last] = await seedThree();
		const toaster = fakeToaster();

		await deleteNoteWithUndo(store, first.id, { notify: toaster });
		await deleteNoteWithUndo(store, middle.id, { notify: toaster });
		expect(await repository.listNotes()).toHaveLength(1);

		// Undo the *first* one, out of order: the second stays deleted.
		pressUndo(toaster.sent[0].data);
		await settle();
		expect(await repository.getNote(first.id)).toEqual(first);
		expect(await repository.getNote(middle.id)).toBeUndefined();
		expect(storedIds()).toEqual([last.id, first.id]);

		// Then the second, which restores the middle note into its own slot.
		pressUndo(toaster.sent[1].data);
		await settle();
		expect(await repository.getNote(middle.id)).toEqual(middle);
		expect(storedIds()).toEqual([last.id, middle.id, first.id]);
	});

	it('a second Undo click on an already used toast is inert', async () => {
		const [note] = await seedThree();
		const toaster = fakeToaster();
		const restore = vi.spyOn(store, 'restoreNote');

		await deleteNoteWithUndo(store, note.id, { notify: toaster });
		pressUndo(toaster.sent[0].data);
		await settle();
		pressUndo(toaster.sent[0].data);
		await settle();

		expect(restore).toHaveBeenCalledOnce();
		restore.mockRestore();
	});
});

describe('focus holds the window open', () => {
	/** The real sonner container the module looks for. */
	function mountToaster(): HTMLButtonElement {
		const toaster = document.createElement('ol');
		toaster.setAttribute('data-sonner-toaster', '');
		const button = document.createElement('button');
		button.textContent = 'Undo';
		toaster.append(button);
		document.body.append(toaster);
		return button;
	}

	afterEach(() => {
		document.querySelector('[data-sonner-toaster]')?.remove();
	});

	it('does not expire while the Undo button has focus, then resumes', async () => {
		const [note] = await seedThree();
		const toaster = fakeToaster();
		const undoButton = mountToaster();

		await deleteNoteWithUndo(store, note.id, { notify: toaster });
		await vi.advanceTimersByTimeAsync(1000);

		// Focus lands on Undo with 4 s left: the deadline is suspended.
		undoButton.focus();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(toaster.dismissed).toEqual([]);

		// Leaving the toast restarts the remaining 4 s, not a fresh 5.
		undoButton.blur();
		await vi.advanceTimersByTimeAsync(3999);
		expect(toaster.dismissed).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(toaster.dismissed).toEqual([toaster.sent[0].data.id]);
	});

	it('still restores when Undo is pressed from the keyboard inside the window', async () => {
		const [note] = await seedThree();
		const toaster = fakeToaster();
		mountToaster();

		await deleteNoteWithUndo(store, note.id, { notify: toaster });
		await vi.advanceTimersByTimeAsync(4999);
		pressUndo(toaster.sent[0].data);
		await settle();

		expect(await repository.getNote(note.id)).toEqual(note);
	});
});

describe('this tab knows what it deleted', () => {
	it('reports the id right away, and stops once the window ends', async () => {
		const [note] = await seedThree();
		const toaster = fakeToaster();

		await deleteNoteWithUndo(store, note.id, { notify: toaster });
		// This is what keeps #7's "deleted in another tab" message out of the tab
		// that did the deleting.
		expect(wasDeletedInThisTab(note.id)).toBe(true);
		expect(wasDeletedInThisTab('some-other-note')).toBe(false);

		await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS + 1);
		expect(wasDeletedInThisTab(note.id)).toBe(false);
	});

	it('forgets the id once that note is restored', async () => {
		const [note] = await seedThree();
		const toaster = fakeToaster();

		await deleteNoteWithUndo(store, note.id, { notify: toaster });
		pressUndo(toaster.sent[0].data);
		await settle();

		expect(wasDeletedInThisTab(note.id)).toBe(false);
	});
});

describe('failures', () => {
	it('reports a refused delete, keeps the record and opens no window', async () => {
		const [note] = await seedThree();
		const toaster = fakeToaster();
		const failing = vi
			.spyOn(store, 'deleteNote')
			.mockRejectedValueOnce(new StorageFullError('Storage is full: no room.'));

		await expect(deleteNoteWithUndo(store, note.id, { notify: toaster })).rejects.toBeInstanceOf(
			StorageFullError
		);

		expect(toaster.sent).toHaveLength(1);
		expect(toaster.sent[0].message).toBe("Couldn't delete the note");
		expect(toaster.sent[0].data.description).toContain('Storage is full');
		expect((await repository.getNote(note.id))?.id).toBe(note.id);
		// No Undo was offered, so the note must not look "deleted here" either.
		expect(wasDeletedInThisTab(note.id)).toBe(false);
		failing.mockRestore();
	});

	it('reports a failed restore instead of pretending the note is back', async () => {
		const [note] = await seedThree();
		const toaster = fakeToaster();
		const failing = vi
			.spyOn(store, 'restoreNote')
			.mockRejectedValueOnce(new StorageFullError('No room to restore.'));

		await deleteNoteWithUndo(store, note.id, { notify: toaster });
		pressUndo(toaster.sent[0].data);
		await settle();

		expect(toaster.sent[1].message).toBe("Couldn't restore the note");
		expect(toaster.sent[1].data.description).toContain('No room to restore');
		expect(await repository.getNote(note.id)).toBeUndefined();
		failing.mockRestore();
	});

	it('propagates a missing note as the store typed error', async () => {
		const toaster = fakeToaster();
		await seedThree();
		await expect(
			deleteNoteWithUndo(store, 'never-existed', { notify: toaster })
		).rejects.toBeInstanceOf(NoteMissingError);
	});
});

describe('finalizeAllUndoWindows', () => {
	it('ends every open window at once', async () => {
		const [first, middle] = await seedThree();
		const toaster = fakeToaster();

		await deleteNoteWithUndo(store, first.id, { notify: toaster });
		await deleteNoteWithUndo(store, middle.id, { notify: toaster });
		finalizeAllUndoWindows();

		expect(toaster.dismissed).toHaveLength(2);
		for (const { data } of toaster.sent) pressUndo(data);
		await settle();
		expect(await repository.getNote(first.id)).toBeUndefined();
		expect(await repository.getNote(middle.id)).toBeUndefined();
	});
});

// A compile-time check that the injected notifier stays assignable to sonner's:
// if `toast` ever changes shape, this file fails to type-check instead of the
// module silently drifting from it.
export const sonnerSatisfiesNotifier: ToastNotifier = toast;
