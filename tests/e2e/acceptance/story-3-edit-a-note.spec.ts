import { expect, test, type Page } from '@playwright/test';
import { hydration } from '../helpers/keyboard';
import { seedNote, seedNotes, waitForList } from '../helpers/seed';
import { editorBody, editorStatus, placeCaretAtEnd, sweepWidths } from './support';

/**
 * Story 3 — **Edit a note**.
 *
 * Epic #1: "autosave ~500 ms after typing stops, and immediately on leaving the
 * note, hiding the tab or closing the page; 'Saving… / Saved' status; on save
 * failure a visible error and the text stays on screen."
 *
 * ## Reuse
 *
 * The debounce, the leave-flush, the hide-flush and the status sequence are
 * proven by #7's `note-editor.spec.ts`; the failure path is proven by unit
 * tests (`tests/unit/note-editor.spec.ts`) and captured as a screenshot by
 * `screenshots-editor.spec.ts`. What this file adds is the part no earlier
 * issue covered end to end: the **visible error** in a real browser, and the
 * five-width sweep including that error state — which is the one editor layout
 * that can overflow, because it adds an alert above the textarea.
 */

/** The note's stored record, or `undefined` when it is gone. */
function storedNote(page: Page, id: string) {
	return page.evaluate(async (noteId) => {
		const open = () =>
			new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('notes-app');
				request.addEventListener('success', () => resolve(request.result));
				request.addEventListener('error', () => reject(request.error));
			});
		const db = await open();
		try {
			return await new Promise<{ id: string; body: string } | undefined>((resolve, reject) => {
				const request = db.transaction('notes', 'readonly').objectStore('notes').get(noteId);
				request.addEventListener('success', () => resolve(request.result));
				request.addEventListener('error', () => reject(request.error));
			});
		} finally {
			db.close();
		}
	}, id);
}

/**
 * Forces the next IndexedDB write to fail with a quota error — what a full disk
 * or a full origin quota does — without touching the app's code.
 *
 * `IDBObjectStore.prototype.put` is the one call the repository's write path
 * makes, so patching it is the narrowest possible seam: `add` (used only when
 * creating) stays intact, and the note under test already exists.
 */
async function failNextWrites(page: Page): Promise<void> {
	await page.evaluate(() => {
		const original = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function patched(): IDBRequest<IDBValidKey> {
			throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
		} as typeof IDBObjectStore.prototype.put;
		(window as unknown as { __restorePut: () => void }).__restorePut = () => {
			IDBObjectStore.prototype.put = original;
		};
	});
}

test.describe('story 3 — Edit a note', () => {
	test('AC1: typing stops, "Saving…" becomes "Saved", and the text is stored', async ({ page }) => {
		const [note] = await seedNotes(page, [seedNote(1, 'Start', new Date().toISOString())]);
		await waitForList(page);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);

		await expect(editorStatus(page)).toHaveAttribute('aria-live', 'polite');
		// An existing note opens *without* focus on purpose (so reading one on a
		// phone does not raise the soft keyboard), so a keyboard user tabs to the
		// textarea. Clicking it here would test the mouse path instead.
		await placeCaretAtEnd(page);
		await page.keyboard.type(' and more');
		await expect(editorStatus(page)).toHaveText('Saved');

		// The status is a claim about storage, so storage is what is asserted.
		await expect(async () => {
			expect((await storedNote(page, note.id))?.body).toBe('Start and more');
		}).toPass();
	});

	test('AC2: leaving inside the debounce window still saves', async ({ page }) => {
		const [note] = await seedNotes(page, [seedNote(1, 'Saved once', new Date().toISOString())]);
		await waitForList(page);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);

		// Type, then leave immediately: the 500 ms debounce has not fired.
		await placeCaretAtEnd(page);
		await page.keyboard.type(' plus more');
		await page.getByRole('heading', { level: 1 }).getByRole('link', { name: 'Notes' }).click();
		await expect(page).toHaveURL('/');

		await expect(async () => {
			expect((await storedNote(page, note.id))?.body).toBe('Saved once plus more');
		}).toPass();
	});

	/**
	 * The failure path, end to end — the one clause of this story with no
	 * browser-level test before #11.
	 *
	 * Two claims in one test on purpose: an error alert that appeared while the
	 * text vanished would satisfy "a visible error" and still lose the note, so
	 * neither half is meaningful alone.
	 */
	test('AC3: a failed save shows a visible error and keeps the text on screen', async ({
		page
	}) => {
		const [note] = await seedNotes(page, [
			seedNote(1, 'Stored before the failure', new Date().toISOString())
		]);
		await waitForList(page);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);

		await placeCaretAtEnd(page);
		await page.keyboard.type(' and one stored edit');
		await expect(editorStatus(page)).toHaveText('Saved');

		await failNextWrites(page);
		await page.keyboard.type(' but this one cannot be stored');

		const alert = page.getByTestId('editor-save-error');
		await expect(alert).toBeVisible();
		await expect(alert).toContainText("Couldn't save");

		// The text the user typed is still there, in full.
		await expect(editorBody(page)).toHaveValue(
			'Stored before the failure and one stored edit but this one cannot be stored'
		);

		// And the retry path exists, announced as an action rather than implied.
		await expect(page.getByTestId('editor-retry')).toBeVisible();
	});

	test('AC4: no horizontal overflow in the editor at every width, including the error state', async ({
		page
	}, testInfo) => {
		const [note] = await seedNotes(page, [seedNote(1, 'Editor sweep', new Date().toISOString())]);
		await waitForList(page);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);

		await sweepWidths(page, testInfo, 'story-3 editor');

		// The error alert is the state that adds markup above the textarea, so it
		// gets its own sweep rather than being assumed safe from the one above.
		// The width is pinned back to the project's own before the error is
		// induced: the sweep above ends at 1920 px, and focusing the textarea
		// straight after a reflow races WebKit's focus handling.
		await page.setViewportSize(page.viewportSize() ?? { width: 1280, height: 800 });
		await failNextWrites(page);
		await placeCaretAtEnd(page);
		await expect(editorBody(page)).toBeFocused();
		await page.keyboard.type(' that fails');
		await expect(page.getByTestId('editor-save-error')).toBeVisible();

		await sweepWidths(page, testInfo, 'story-3 editor with save error');
	});
});
