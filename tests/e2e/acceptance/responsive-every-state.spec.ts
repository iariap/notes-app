import { expect, test, type Page } from '@playwright/test';
import { hydration } from '../helpers/keyboard';
import { seedNote, seedNotes, waitForList } from '../helpers/seed';
import {
	RICH_BODY,
	dismissStorageNotice,
	expectNoOverflowWithScreenshot,
	placeCaretAtEnd,
	sweepWidths,
	waitForToastSettled
} from './support';

/**
 * The responsive sweep, as the issue enumerates it: "for every route and state
 * (empty list, populated list, editor, preview tabs/side-by-side, delete toast,
 * storage notice, save-error alert) assert no horizontal overflow at 320, 375,
 * 768, 1280 and 1920 px, and save screenshots as test artifacts".
 *
 * ## Why a separate file from the story specs
 *
 * The story specs sweep the states *their* story owns, which keeps the mapping
 * "story → evidence" honest. This file exists so a state cannot fall through:
 * it is the checklist, in the issue's own words, and a state added to the app
 * later has an obvious place to be swept. Every width is asserted at each state
 * — five widths × eight states — rather than a sample.
 *
 * ## Screenshots
 *
 * `testInfo.attach` puts one PNG per (state, width) in the report. They are
 * artifacts, not fixtures: nothing is written into the repo, so a run cannot
 * dirty the tree, and CI keeps them in the uploaded Playwright report.
 */

/** Forces the next IndexedDB write to fail, surfacing the save-error alert. */
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

/** The page's own overflow, including any fixed-position chrome. */
async function documentOverflow(page: Page): Promise<number> {
	return page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
}

/**
 * A toast is fixed-positioned *outside* the shell's `overflow: hidden`, so it
 * can push the document wider than the viewport even though every route fits.
 * This asserts it does not, at the current size — the check the issue's
 * "delete toast" state is really about.
 */
async function expectToastInsideViewport(page: Page, width: number): Promise<void> {
	const toast = page.locator('[data-sonner-toast]').first();
	await expect(toast).toBeVisible();
	const box = (await toast.boundingBox())!;
	expect(box.x, `the toast starts off-screen at ${width}px`).toBeGreaterThanOrEqual(-1);
	expect(box.x + box.width, `the toast ends off-screen at ${width}px`).toBeLessThanOrEqual(
		width + 1
	);
}

test.describe('responsive — every route and state', () => {
	test('empty list', async ({ page }, testInfo) => {
		await seedNotes(page, []);
		await waitForList(page);
		await sweepWidths(page, testInfo, 'empty list');
	});

	test('populated list', async ({ page }, testInfo) => {
		const now = Date.now();
		await seedNotes(page, [
			seedNote(1, 'Groceries\n- milk\n- eggs', new Date(now - 3_600_000).toISOString()),
			seedNote(2, RICH_BODY, new Date(now - 10_800_000).toISOString()),
			// A title that cannot wrap: the worst case for a 320 px row.
			seedNote(3, 'x'.repeat(400), new Date(now - 864_000_000).toISOString())
		]);
		await waitForList(page);
		await sweepWidths(page, testInfo, 'populated list');
	});

	test('editor with content', async ({ page }, testInfo) => {
		const [note] = await seedNotes(page, [seedNote(1, RICH_BODY, new Date().toISOString())]);
		await waitForList(page);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);
		await sweepWidths(page, testInfo, 'editor');
	});

	test('preview behind the tabs (below xl) and side by side (xl and up)', async ({
		page
	}, testInfo) => {
		const [note] = await seedNotes(page, [seedNote(1, RICH_BODY, new Date().toISOString())]);
		await waitForList(page);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);

		// 320, 375 and 768 are all below `xl`, so the tabbed layout is what those
		// widths render — and it is swept through the Preview tab.
		for (const width of [320, 375, 768] as const) {
			await page.setViewportSize({ width, height: 800 });
			await page.getByRole('tab', { name: 'Preview' }).click();
			await expect(page.getByTestId('preview-pane')).toBeVisible();
			await expectNoOverflowWithScreenshot(page, testInfo, 'preview tabs', width);
			await page.getByRole('tab', { name: 'Edit' }).click();
		}

		// 1280 and 1920 show both panes at once; there is no tab to press.
		for (const width of [1280, 1920] as const) {
			await page.setViewportSize({ width, height: 800 });
			await expect(page.getByTestId('preview-pane')).toBeVisible();
			await expect(page.getByTestId('editor-view-tabs')).toBeHidden();
			await expectNoOverflowWithScreenshot(page, testInfo, 'preview side by side', width);
		}
	});

	test('delete toast, at every width', async ({ page }, testInfo) => {
		const now = Date.now();
		await seedNotes(page, [
			seedNote(1, 'A note to delete', new Date(now - 60_000).toISOString()),
			seedNote(2, 'A note to keep', new Date(now - 120_000).toISOString())
		]);
		await waitForList(page);

		await page.goto('/notes/seeded-0001');
		await hydration(page);
		await page.getByRole('button', { name: 'Delete note' }).click();
		await expect(page.locator('[data-sonner-toast]')).toBeVisible();
		await waitForToastSettled(page);

		await sweepWidths(page, testInfo, 'delete toast');
		// The toast is fixed-position and sits outside the shell's clipping, so
		// the document-level check above is not sufficient on its own.
		for (const width of [320, 375, 768, 1280, 1920] as const) {
			await page.setViewportSize({ width, height: 800 });
			await expectToastInsideViewport(page, width);
		}
	});

	test('storage notice, at every width', async ({ page }, testInfo) => {
		// Deliberately *not* dismissed: the notice only exists on a first visit.
		await page.goto('/');
		await expect(page.getByTestId('storage-notice')).toBeVisible();
		await sweepWidths(page, testInfo, 'storage notice');
	});

	test('save-error alert, at every width', async ({ page }, testInfo) => {
		const [note] = await seedNotes(page, [seedNote(1, 'A note', new Date().toISOString())]);
		await waitForList(page);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);

		await failNextWrites(page);
		await placeCaretAtEnd(page);
		await page.keyboard.type(' that cannot be stored');
		await expect(page.getByTestId('editor-save-error')).toBeVisible();

		await sweepWidths(page, testInfo, 'save error');
	});

	test('the missing-note and deleted-in-another-tab states, at every width', async ({
		page,
		context
	}, testInfo) => {
		await dismissStorageNotice(page);

		await page.goto('/notes/does-not-exist');
		await hydration(page);
		await expect(page.getByTestId('editor-missing')).toBeVisible();
		await sweepWidths(page, testInfo, 'missing note');

		// Deleted in another tab: the editor's third terminal state, and the one
		// with the longest copy, so it is the likeliest to overflow.
		const [note] = await seedNotes(page, [seedNote(1, 'Doomed', new Date().toISOString())]);
		await waitForList(page);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);

		const other = await context.newPage();
		await other.goto(`/notes/${note.id}`);
		await hydration(other);
		await page.getByRole('button', { name: 'Delete note' }).click();
		await expect(other.getByTestId('editor-deleted')).toBeVisible();

		await other.setViewportSize({ width: 320, height: 800 });
		for (const width of [320, 375, 768, 1280, 1920] as const) {
			await expectNoOverflowWithScreenshot(other, testInfo, 'deleted in another tab', width);
		}
	});

	test('the document never scrolls vertically: each pane scrolls itself', async ({ page }) => {
		// The layout invariant #5 established, re-asserted at the two widths where
		// the pane structure changes: single column below `md`, two panes above.
		for (const width of [375, 768, 1280] as const) {
			await page.setViewportSize({ width, height: 800 });
			await page.goto('/notes/new');
			await hydration(page);
			await page.keyboard.type(
				Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n')
			);

			const docScrollable = await page.evaluate(
				() => document.documentElement.scrollHeight > document.documentElement.clientHeight + 1
			);
			expect(docScrollable, `the document scrolls at ${width}px`).toBe(false);
			expect(await documentOverflow(page), `overflow at ${width}px`).toBeLessThanOrEqual(0);
		}
	});
});
