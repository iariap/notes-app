import { expect, test, type Page } from '@playwright/test';
import { hydration, isNarrow } from '../helpers/keyboard';
import { rowTitles, seedNote, seedNotes, waitForList, type SeedNote } from '../helpers/seed';
import { deleteToast, sweepWidths, undoButton, waitForToastSettled } from './support';

/**
 * Story 4 — **Delete a note**.
 *
 * Epic #1: "removed immediately; 'Note deleted · Undo' toast for 5 s; Undo
 * restores the identical note (same id, body, dates, position)."
 *
 * ## Reuse
 *
 * #8's `delete.spec.ts` already proves all of it, including the 5 s window
 * driven by a fake clock and the byte-for-byte restoration. This file adds the
 * two things acceptance testing is for: the responsive sweep of the toast state
 * (which #8 never swept — the toast is the one fixed-position element that can
 * overflow a 320 px phone) and the axe scan of that state at every engine.
 */

/** Three notes an hour apart, so the list order is unambiguous and stable. */
function threeNotes(now: number): SeedNote[] {
	return [
		seedNote(1, 'First note', new Date(now - 30 * 60_000).toISOString()),
		seedNote(2, 'Second note', new Date(now - 20 * 60_000).toISOString()),
		seedNote(3, 'Third note', new Date(now - 10 * 60_000).toISOString())
	];
}

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
			return await new Promise<
				{ id: string; body: string; createdAt: string; updatedAt: string } | undefined
			>((resolve, reject) => {
				const request = db.transaction('notes', 'readonly').objectStore('notes').get(noteId);
				request.addEventListener('success', () => resolve(request.result));
				request.addEventListener('error', () => reject(request.error));
			});
		} finally {
			db.close();
		}
	}, id);
}

/** Deletes the middle note from the editor and returns the notes and the target. */
async function deleteMiddleNote(page: Page) {
	const notes = await seedNotes(page, threeNotes(Date.now()));
	await waitForList(page);
	const target = notes[1];
	await page.goto(`/notes/${target.id}`);
	await hydration(page);
	await page.getByRole('button', { name: 'Delete note' }).click();
	await expect(deleteToast(page)).toBeVisible();
	return { notes, target };
}

test.describe('story 4 — Delete a note', () => {
	test('AC1: the note is removed immediately and the Undo toast appears', async ({ page }) => {
		const { target } = await deleteMiddleNote(page);

		// Removed from storage before the window closes, not after it.
		expect(await storedNote(page, target.id)).toBeUndefined();
		await expect(page).toHaveURL('/');
		await expect(page.locator('[data-slot="note-row"]')).toHaveCount(2);
		await expect(deleteToast(page)).toContainText('Note deleted');
		await expect(undoButton(page)).toBeVisible();
	});

	test('AC2: Undo restores the identical note in the same position', async ({ page }) => {
		const notes = await seedNotes(page, threeNotes(Date.now()));
		await waitForList(page);
		const before = await rowTitles(page);
		expect(before).toEqual(['Third note', 'Second note', 'First note']);

		const target = notes[1];
		await page.goto(`/notes/${target.id}`);
		await hydration(page);
		await page.getByRole('button', { name: 'Delete note' }).click();
		await expect(page).toHaveURL('/');
		await undoButton(page).click();

		// Same position…
		await expect(page.locator('[data-slot="note-row"]')).toHaveCount(3);
		expect(await rowTitles(page)).toEqual(before);

		// …and the same record: id, body and *both* dates, which is what puts it
		// back in its slot (the list sorts by `updatedAt`).
		await expect(async () => {
			expect(await storedNote(page, target.id)).toEqual(target);
		}).toPass();
	});

	test('AC3: no horizontal overflow with the Undo toast up, at 320 through 1920 px', async ({
		page
	}, testInfo) => {
		await deleteMiddleNote(page);
		await waitForToastSettled(page);

		// The toast is fixed-position and therefore outside the flow the shell
		// constrains: it is exactly the state a sweep of the routes would miss.
		await sweepWidths(page, testInfo, 'story-4 delete toast');
	});

	test('AC4: the Delete control is a 44 px target at every width', async ({ page }) => {
		const notes = await seedNotes(page, threeNotes(Date.now()));
		await waitForList(page);
		await page.goto(`/notes/${notes[0].id}`);
		await hydration(page);

		const button = page.getByRole('button', { name: 'Delete note' });
		await expect(button).toBeVisible();
		// The accessible name is the same everywhere; only the visible label changes.
		await expect(button).toHaveAccessibleName('Delete note');

		const box = (await button.boundingBox())!;
		expect(box.width).toBeGreaterThanOrEqual(44);
		expect(box.height).toBeGreaterThanOrEqual(44);

		// Inside the viewport, so a phone user can actually reach it.
		const viewport = page.viewportSize()!;
		expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
		expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

		const label = button.locator('span');
		if (isNarrow(page)) {
			await expect(label).toBeHidden();
		} else {
			await expect(label).toBeVisible();
		}
	});

	test('AC5: the deletion is final once the window closes, and survives a reload', async ({
		page
	}) => {
		const { target } = await deleteMiddleNote(page);

		// Let the 5 s window lapse instead of reloading inside it: the claim is
		// that the delete is final, so Undo must be gone rather than merely unclicked.
		await expect(deleteToast(page)).toHaveCount(0, { timeout: 10_000 });
		await page.reload();
		await waitForList(page);

		expect(await rowTitles(page)).toEqual(['Third note', 'First note']);
		expect(await storedNote(page, target.id)).toBeUndefined();
	});
});
