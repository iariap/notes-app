/**
 * Delete with Undo (#8).
 *
 * A delete is immediate and durable: the record leaves storage before anything
 * is shown, and this module never re-creates it on its own. What the toast buys
 * the user is a five second window in which the *exact* record it captured can
 * be put back — same id, same body, same `createdAt`/`updatedAt`, so it returns
 * to the same place in the list.
 *
 * ## Why the window is ours and not sonner's
 *
 * The toast is created with `duration: Infinity` and this module owns a 5000 ms
 * timer instead of letting sonner auto-close it. Sonner pauses its own timer
 * while the mouse is over the toast or while it is being pressed, but **not**
 * while the Undo button merely has focus, and the issue requires that a focused
 * toast does not disappear under a keyboard user. One clock also means the
 * moment "the note becomes unrecoverable" is decided in one place instead of
 * inferred from an exit animation.
 *
 * ## Each delete is its own window
 *
 * Every call captures its own record in its own closure and gets its own toast
 * id. There is deliberately no "last deleted note" variable: with two quick
 * deletes, an Undo must restore the note that toast belongs to and nothing else,
 * and a stale Undo (expired, already used, or after `pagehide`) must be inert
 * rather than restore whatever happened to be deleted last.
 *
 * ## Why `wasDeletedInThisTab`
 *
 * #7 shows "This note was deleted in another tab" when a note disappears from
 * under the editor. That message is wrong in the tab that performed the delete —
 * there and only there, the disappearance is the user's own click. The ids this
 * tab deleted are recorded *before* the write, so the editor can tell the two
 * apart without waiting for anything.
 *
 * ## Undo returns focus to the restored row (#26)
 *
 * Dismissing the toast removes the Undo button, and the browser drops focus to
 * `<body>` when the element that holds it goes away. On the delete path the list
 * answers that with `focusAfterRemoval`; the undo path had nothing, so a keyboard
 * user who pressed Undo lost their place in the document.
 *
 * The hand-off therefore runs here, dismissing the toast first and moving focus
 * after, and lands where the delete path leaves it: the row of the note that came
 * back. Two things had to be measured rather than assumed:
 *
 * - **The order is not what makes it stick.** Handing off before the dismissal is
 *   equally final, because `focusAfterRemoval` retries on animation frames and
 *   sonner removes the toast ~200 ms later, inside that budget. Dismissing first
 *   is still what the sequence reads as (the removal is the event being answered),
 *   but the claim rests on the release below, not on the ordering.
 * - **The release is.** Focus is *inside the toast* when Undo is pressed — the
 *   realistic undo is Enter on the button — and `focusAfterRemoval`'s guard
 *   (correctly) refuses to move focus away from anything live. Without releasing
 *   that control first, focus stays on the dying toast and falls to `<body>` with
 *   it: measured, every focused test fails. Releasing it is the same statement
 *   `NoteEditor.focusListRow` makes about its textarea, and the guard is then
 *   satisfied for the reason it exists instead of refusing on behalf of a node
 *   that is on its way out. `notes-focus.ts` itself is unchanged.
 */
import { toast, type ExternalToast } from 'svelte-sonner';
import { focusAfterRemoval } from '$lib/components/notes-focus';
import type { Note } from './types';

export const DELETE_TOAST_MESSAGE = 'Note deleted';
export const UNDO_ACTION_LABEL = 'Undo';
export const DELETE_FAILED_MESSAGE = "Couldn't delete the note";
export const UNDO_FAILED_MESSAGE = "Couldn't restore the note";

/** How long after a delete the Undo toast keeps offering the record back. */
export const UNDO_WINDOW_MS = 5000;

/** Sonner's container; focus inside it holds every open window. */
const TOASTER_SELECTOR = '[data-sonner-toaster]';

/** One toast within that container; the node a dismissal removes. */
const TOAST_TOAST_SELECTOR = '[data-sonner-toast]';

type ToastId = string | number;

/** The slice of `svelte-sonner`'s `toast` this module needs (injectable in tests). */
export interface ToastNotifier {
	(message: string, data?: ExternalToast): ToastId;
	dismiss(id?: ToastId): unknown;
}

/** The store operations a delete needs; `NotesStore` satisfies it. */
export interface DeleteTarget {
	deleteNote(id: string): Promise<Note>;
	restoreNote(note: Note): Promise<void>;
}

export interface DeleteOptions {
	/** Defaults to the app toaster; tests inject their own. */
	notify?: ToastNotifier;
	/** Defaults to `UNDO_WINDOW_MS`. */
	windowMs?: number;
}

interface UndoSession {
	id: ToastId;
	/** The exact record to put back — captured here, never looked up again. */
	note: Note;
	target: DeleteTarget;
	notify: ToastNotifier;
	/** Milliseconds left while the clock is paused. */
	remaining: number;
	/** When the running timer started (`null` while paused or expired). */
	startedAt: number | null;
	timer: ReturnType<typeof setTimeout> | null;
	/** The window is over: Undo is a no-op from here on. */
	closed: boolean;
}

/** Open windows, keyed by toast id. Each one restores only its own note. */
const sessions = new Map<ToastId, UndoSession>();

/**
 * Ids deleted by this tab, with the instant of the delete. Entries outlive the
 * window only as long as the editor needs to notice it is gone.
 */
const deletedHere = new Map<string, number>();

let sequence = 0;
let listening = false;

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// --- the Undo window -------------------------------------------------------

function stopTimer(session: UndoSession): void {
	if (session.timer !== null) {
		clearTimeout(session.timer);
		session.timer = null;
	}
	session.startedAt = null;
}

/** Ends the window without touching storage: the deletion becomes final. */
function closeSession(session: UndoSession): void {
	if (session.closed) return;
	session.closed = true;
	session.remaining = 0;
	stopTimer(session);
	sessions.delete(session.id);
}

function expire(session: UndoSession): void {
	if (session.closed) return;
	closeSession(session);
	session.notify.dismiss(session.id);
}

function focusIsInToaster(): boolean {
	if (typeof document === 'undefined') return false;
	const active = document.activeElement;
	return active instanceof Element && active.closest(TOASTER_SELECTOR) !== null;
}

function startTimer(session: UndoSession): void {
	if (session.closed || session.timer !== null) return;
	// A keyboard user is on the toast right now: hold the window until they leave.
	if (focusIsInToaster()) return;
	session.startedAt = Date.now();
	session.timer = setTimeout(
		() => {
			session.timer = null;
			session.startedAt = null;
			session.remaining = 0;
			// Focus may have arrived in the same tick the deadline did.
			if (focusIsInToaster()) return;
			expire(session);
		},
		Math.max(0, session.remaining)
	);
}

function pauseTimer(session: UndoSession): void {
	if (session.timer === null) return;
	const elapsed = Date.now() - (session.startedAt ?? Date.now());
	session.remaining = Math.max(0, session.remaining - elapsed);
	stopTimer(session);
}

function resumeTimer(session: UndoSession): void {
	if (session.closed || session.timer !== null) return;
	if (session.remaining <= 0) {
		expire(session);
		return;
	}
	startTimer(session);
}

function onFocusIn(event: FocusEvent): void {
	const target = event.target;
	if (!(target instanceof Element) || target.closest(TOASTER_SELECTOR) === null) return;
	for (const session of sessions.values()) pauseTimer(session);
}

function onFocusOut(event: FocusEvent): void {
	const next = event.relatedTarget;
	if (next instanceof Element && next.closest(TOASTER_SELECTOR) !== null) return;
	for (const session of [...sessions.values()]) resumeTimer(session);
}

/**
 * Registers the listeners the window depends on: focus (pause/resume) and
 * `pagehide` (the page is going away, so every open window ends at once — there
 * is no later moment in which that Undo could run).
 */
function attachListeners(): void {
	if (listening || typeof document === 'undefined') return;
	listening = true;
	document.addEventListener('focusin', onFocusIn);
	document.addEventListener('focusout', onFocusOut);
	window.addEventListener('pagehide', finalizeAllUndoWindows);
}

/**
 * Ends every open window: used on `pagehide`, where a toast that survived would
 * be a promise the page can no longer keep.
 */
export function finalizeAllUndoWindows(): void {
	for (const session of [...sessions.values()]) expire(session);
}

/**
 * The toast an action press belongs to: the one whose button sonner wired the
 * handler to.
 *
 * Read from the event, at the moment the handler runs — which is *before* the
 * dismissal, while the button is still in the document. This is deliberately not
 * "the toast focus happens to be in": with two windows open, pressing one toast's
 * Undo while the other holds focus must not touch the second one (#21), and only
 * the pressed button says which toast is going away.
 */
function toastRootOf(event: Event): Element | null {
	const target = event.currentTarget;
	return target instanceof Element ? target.closest(TOAST_TOAST_SELECTOR) : null;
}

/**
 * Whether focus is on the toast that is now being dismissed, and so is about to
 * be removed from the document.
 *
 * The realistic Undo is a keypress on the toast's own button, so `undo()` runs
 * with focus *inside the toast it is dismissing* — and that whole node is going
 * away, so its focus is not a competing owner. Releasing it is the same statement
 * `NoteEditor.focusListRow` makes about its textarea before the Esc hand-off.
 *
 * The scope is that one toast, never "anything in the toaster": with two deletes
 * open, a mouse click on one toast while the other holds focus must leave the
 * other alone — that is #21, and blurring it would be the steal the guard exists
 * to prevent.
 */
function focusIsOnDyingToast(root: Element | null): boolean {
	if (root === null || typeof document === 'undefined') return false;
	const active = document.activeElement;
	return active instanceof Element && (active === root || root.contains(active));
}

/**
 * Hands focus to the row of the note that just came back (#26).
 *
 * `focusAfterRemoval`'s own guard still decides — it is unchanged, and it still
 * refuses whenever anything live holds focus (a row the user is on, another
 * toast). The one thing released first is the dismissing toast's own control,
 * which is not live: see `focusIsOnDyingToast`. Without that release the guard
 * refuses, focus stays on the toast, and the removal drops it to `<body>` — the
 * defect itself, measured.
 */
function focusRestoredRow(id: string, dyingToast: Element | null): void {
	if (focusIsOnDyingToast(dyingToast)) {
		(document.activeElement as HTMLElement | null)?.blur();
	}
	focusAfterRemoval(id);
}

async function undo(session: UndoSession, dyingToast: Element | null): Promise<void> {
	// Inert once the window closed: a click that arrives after expiry (or after
	// this same Undo already ran) must not touch storage.
	if (session.closed) return;
	closeSession(session);
	let restored: string | null = null;
	try {
		await session.target.restoreNote(session.note);
		// The note exists again in this tab, so this id is no longer "deleted".
		deletedHere.delete(session.note.id);
		restored = session.note.id;
	} catch (error) {
		session.notify(UNDO_FAILED_MESSAGE, { description: messageOf(error) });
	} finally {
		session.notify.dismiss(session.id);
		// Only a note that is really back has a row to land on: a failed restore
		// leaves the list unchanged, and the user is told what happened instead.
		if (restored !== null) focusRestoredRow(restored, dyingToast);
	}
}

function openSession(
	target: DeleteTarget,
	note: Note,
	notify: ToastNotifier,
	windowMs: number
): void {
	attachListeners();
	const session: UndoSession = {
		id: `note-deleted-${(sequence += 1)}`,
		note,
		target,
		notify,
		remaining: windowMs,
		startedAt: null,
		timer: null,
		closed: false
	};
	sessions.set(session.id, session);
	notify(DELETE_TOAST_MESSAGE, {
		id: session.id,
		// See the module comment: our timer decides when the note is final, and
		// it is the only one that pauses while Undo has focus.
		duration: Number.POSITIVE_INFINITY,
		action: {
			label: UNDO_ACTION_LABEL,
			// Sonner calls this with the button it wired up, so the toast being
			// dismissed is identified here, while the node is still in the DOM.
			// Typed as `Event` (the broader parameter): what is read is the
			// handler's own target, not anything sonner narrows for the handler.
			onClick: (event: Event) => {
				const dyingToast = toastRootOf(event);
				void undo(session, dyingToast);
			}
		}, // Dismissed by the user (swipe, close button) or auto-closed: either way
		// the window is over and the deletion is final.
		onDismiss: () => closeSession(session),
		onAutoClose: () => closeSession(session)
	});
	startTimer(session);
}

// --- this tab's deletes ----------------------------------------------------

/**
 * `true` when this tab deleted `id` within the last window: the editor uses it
 * to tell its own delete apart from one that arrived from another tab.
 */
export function wasDeletedInThisTab(id: string, now: number = Date.now()): boolean {
	const deletedAt = deletedHere.get(id);
	if (deletedAt === undefined) return false;
	if (now - deletedAt > UNDO_WINDOW_MS) {
		deletedHere.delete(id);
		return false;
	}
	return true;
}

/**
 * Deletes `id` right away and opens its own Undo window.
 *
 * Never navigates and never flushes: the caller decides what to do with the
 * screen afterwards. Rejects with the store's typed error (after telling the
 * user), leaving storage and the list exactly as they were.
 */
export async function deleteNoteWithUndo(
	target: DeleteTarget,
	id: string,
	{ notify = toast, windowMs = UNDO_WINDOW_MS }: DeleteOptions = {}
): Promise<Note> {
	// Recorded before the write, so a view that sees the note vanish already
	// knows this tab was the one that removed it.
	deletedHere.set(id, Date.now());
	let note: Note;
	try {
		note = await target.deleteNote(id);
	} catch (error) {
		deletedHere.delete(id);
		notify(DELETE_FAILED_MESSAGE, { description: messageOf(error) });
		throw error;
	}
	openSession(target, note, notify, windowMs);
	return note;
}

/** Test seam: drops every open window and the listeners that drive them. */
export function resetDeleteUndoForTests(): void {
	for (const session of [...sessions.values()]) closeSession(session);
	deletedHere.clear();
	sequence = 0;
	if (listening) {
		document.removeEventListener('focusin', onFocusIn);
		document.removeEventListener('focusout', onFocusOut);
		window.removeEventListener('pagehide', finalizeAllUndoWindows);
		listening = false;
	}
}
