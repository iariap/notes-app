/**
 * Where focus goes after a note is deleted (#8).
 *
 * The control that started the delete is gone with the row (or with the note
 * the editor was showing), and a browser drops focus to `<body>` when that
 * happens — a keyboard user would be back at the top of the document with no
 * indication of where they are. So focus moves to the nearest sensible place:
 * the row that took the deleted one's spot, else the first row, else the way to
 * create a note. All three are things a user can act on immediately.
 *
 * It retries for a few frames because the row that should take the focus may
 * not be on screen yet: the list re-reads storage after a write, and while that
 * read is in flight it renders its skeleton, not its rows. Focusing once, in
 * that gap, would leave focus exactly where this function exists to keep it out
 * of — on `<body>`.
 */

interface Identifiable {
	id: string;
}

/** Frames to wait for the row to appear (~130 ms at 60 Hz). Bounded on purpose. */
const RETRY_FRAMES = 8;

/**
 * The note that now occupies the deleted one's place: the next in list order,
 * or the previous one when it was last. Computed from the list *before* the
 * delete, because afterwards that order is gone.
 */
export function neighborId(notes: readonly Identifiable[], removedId: string): string | null {
	const index = notes.findIndex((note) => note.id === removedId);
	if (index === -1) return null;
	return notes[index + 1]?.id ?? notes[index - 1]?.id ?? null;
}

function rowFor(id: string): HTMLElement | null {
	return document.querySelector<HTMLElement>(`[data-slot="note-row"][data-note-id="${id}"]`);
}

/**
 * The best element on screen to receive focus right now, if there is one.
 *
 * The "New note" entry point in the *header* is deliberately not part of the
 * usual chain: it is always mounted, so returning it while the list is merely
 * re-reading storage (skeleton up, rows on their way back) would settle for the
 * header instead of waiting for the row this function was asked to land on. It
 * is only used as a last resort, once the list is settled and truly empty.
 */
function candidate(preferredId?: string | null, lastResort = false): HTMLElement | null {
	const row =
		(preferredId ? rowFor(preferredId) : null) ??
		document.querySelector<HTMLElement>('[data-slot="note-row"]');
	if (row !== null) return row;
	const emptyState = document.querySelector<HTMLElement>('[data-testid="note-list-empty"] a');
	if (emptyState !== null) return emptyState;
	if (!lastResort) return null;
	return document.querySelector<HTMLElement>('[data-testid="new-note"]');
}

/**
 * Moves focus to `preferredId`'s row when it exists, otherwise to the first row,
 * otherwise to the "New note" entry point.
 *
 * It does nothing at all when something other than `<body>` already holds focus,
 * and that is checked on the first attempt as well as on every retry: the user
 * moving focus — to the Undo action in the delete toast, most of all — outranks
 * this cleanup. The legitimate case is *not* covered by that check, and must not
 * be: after a delete the control the user pressed is gone with its row, so the
 * browser has already dropped focus to `<body>` and the move proceeds.
 *
 * The check sits before `candidate()` on purpose. Testing the condition only
 * after finding no target (where it used to live) let a row that was on screen
 * win every time, so focus was taken unconditionally while the toast was being
 * read from the keyboard — which resumed #8's five second window and closed the
 * toast under the user.
 */
export function focusAfterRemoval(preferredId?: string | null): void {
	let remaining = RETRY_FRAMES;
	const attempt = (): void => {
		// Something live holds focus: whoever moved it there knows more than this
		// cleanup does, so there is nothing left to do — now or in a later frame.
		if (document.activeElement !== null && document.activeElement !== document.body) return;
		const target = candidate(preferredId, remaining === 0);
		if (target !== null) {
			// `preventScroll` keeps the list where the user left it; focusing is
			// about the keyboard, not about moving the viewport.
			target.focus({ preventScroll: true });
			return;
		}
		remaining -= 1;
		if (remaining < 0) return;
		requestAnimationFrame(attempt);
	};
	attempt();
}
