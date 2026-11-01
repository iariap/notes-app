import { expect, test } from '@playwright/test';
import { isNarrow } from '../helpers/keyboard';
import { rowTitles, rows, seedNote, seedNotes, waitForList } from '../helpers/seed';
import { openList, sampleNotes, sweepWidths } from './support';

/**
 * Story 1 — **See my notes**.
 *
 * Epic #1: "list with title, ~100-char plain-text preview and created date,
 * most recently edited first; empty state with a 'New note' button."
 *
 * ## Reuse, not duplication
 *
 * Every criterion of this story is already proven end to end by `#6`'s
 * `notes-list.spec.ts`, at all three original viewports. Rewriting those
 * assertions here would double the runtime and, worse, create a second place to
 * update when the row changes. The mapping — which test proves which clause — is
 * in `docs/qa-v1.md`; what this file adds is only what #6 could not: the
 * behaviour in the engines added by #11 and the five-width sweep.
 *
 * The two things #6 pins to a literal viewport width and this file re-asserts
 * at every engine: the list has to survive a narrow phone, and the row has to
 * stay reachable when it does.
 */

test.describe('story 1 — See my notes', () => {
	test('AC1: rows show title, a plain-text preview and the created date, newest edit first', async ({
		page
	}) => {
		// The same three notes #6 uses, so the expected order is not invented
		// here: created a minute apart, listed newest edit first.
		const now = Date.now();
		await openList(page, sampleNotes(now));

		expect(await rowTitles(page)).toEqual(['Groceries', 'Weekly plan', 'Old note']);

		const first = rows(page).nth(0);
		await expect(first).toContainText('milk');
		// Markdown is stripped, never shown raw.
		await expect(first).not.toContainText('##');
		await expect(first.locator('time')).toBeVisible();
	});

	test('AC2: the empty state offers a "New note" button that opens the editor', async ({
		page
	}) => {
		await openList(page, []);

		const empty = page.getByTestId('note-list-empty');
		await expect(empty).toBeVisible();
		await expect(empty).toContainText('No notes yet');

		await empty.getByRole('link', { name: 'New note' }).click();
		await expect(page).toHaveURL(/\/notes\/new$/);
	});

	test('AC3: no horizontal overflow at 320, 375, 768, 1280 and 1920 px (populated list)', async ({
		page
	}, testInfo) => {
		await openList(page, sampleNotes());
		await sweepWidths(page, testInfo, 'story-1 list with notes');
	});

	test('AC4: no horizontal overflow at 320, 375, 768, 1280 and 1920 px (empty state)', async ({
		page
	}, testInfo) => {
		await openList(page, []);
		await sweepWidths(page, testInfo, 'story-1 empty list');
	});

	test('AC5: a 320 px phone keeps every row tappable and the list scrollable', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 568 });
		await openList(page, sampleNotes());

		// 44 px is the epic's touch-target floor, asserted for the interactive
		// controls a phone user presses — not for the row text.
		const rowBox = (await rows(page).first().boundingBox())!;
		expect(rowBox.height).toBeGreaterThanOrEqual(44);

		const menuBox = (await page.locator('[data-testid="note-row-menu"]').first().boundingBox())!;
		expect(menuBox.width).toBeGreaterThanOrEqual(44);
		expect(menuBox.height).toBeGreaterThanOrEqual(44);

		// And the list itself does not scroll sideways, which would hide the
		// date column on the narrowest phone in the matrix.
		const listOverflow = await page
			.locator('[data-slot="note-list"]')
			.evaluate((element) => element.scrollWidth - element.clientWidth);
		expect(listOverflow).toBeLessThanOrEqual(1);
	});

	test('AC6: the list is reachable as a labelled region on every engine', async ({ page }) => {
		await openList(page, sampleNotes());

		const region = page.getByRole('region', { name: 'Notes' });
		await expect(region).toBeVisible();
		// The rows are a real list, so a screen reader announces the count.
		await expect(region.getByRole('listitem')).toHaveCount(3);
	});

	test('AC7: opening a row on a phone hides the list; on a wide screen it stays beside the editor', async ({
		page
	}) => {
		const [note] = await seedNotes(page, [seedNote(1, 'A note', new Date().toISOString())]);
		await waitForList(page);
		await rows(page).first().click();

		await expect(page).toHaveURL(new RegExp(`/notes/${note.id}$`));
		const listPane = page.locator('[data-pane="list"]');
		if (isNarrow(page)) {
			// Single column: the editor takes over, and the back affordance is the
			// way to the list.
			await expect(page.getByRole('link', { name: 'Back to notes' })).toBeVisible();
			expect(await listPane.evaluate((element) => getComputedStyle(element).display)).toBe('none');
		} else {
			await expect(listPane).toBeVisible();
			await expect(listPane.locator('[aria-current="page"]')).toHaveCount(1);
		}
	});
});
