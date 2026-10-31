import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { seedNotes } from './helpers/seed';

/**
 * Screenshot capture for PR evidence of the editor (#7). Opt-in, same pattern as
 * the shell/list/notice specs: `SCREENSHOTS=1 pnpm test:e2e`.
 *
 * Writes `docs/screenshots/editor-<width>.png` plus `editor-error-1280.png`
 * (the save-failure alert) and, when `SCREENSHOT_OUT_DIR` is set, a copy of each
 * in that directory.
 */
const SHOT_DIR = path.resolve(import.meta.dirname, '../../docs/screenshots');
const VIEWPORTS = [
	{ width: 375, height: 667 },
	{ width: 768, height: 1024 },
	{ width: 1280, height: 800 }
];

/** A body with a little Markdown, long enough to look like real writing. */
const SAMPLE = [
	'# Groceries',
	'',
	'- [ ] milk',
	'- [x] eggs',
	'- [ ] sourdough starter',
	'',
	'Remember the market closes at 8 on Thursdays.'
].join('\n');

/**
 * Starts from an empty database, so the shots show one note instead of whatever
 * earlier runs left behind, and the storage notice is dismissed so the editor
 * gets the whole pane. `seedNotes(page, [])` is the same helper the other
 * screenshot specs use: it waits for the app's own database open, so clearing
 * never races the first read, and it reloads afterwards.
 */
async function startClean(page: import('@playwright/test').Page): Promise<void> {
	await page.addInitScript(() => {
		window.localStorage.setItem('notes.storageNoticeDismissed', 'true');
	});
	await seedNotes(page, []);
}

test.describe('editor screenshots', () => {
	test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to capture screenshots');

	test('the editor at 375, 768 and 1280', async ({ page }) => {
		const outDirs = [SHOT_DIR];
		if (process.env.SCREENSHOT_OUT_DIR) outDirs.push(path.resolve(process.env.SCREENSHOT_OUT_DIR));
		for (const dir of outDirs) fs.mkdirSync(dir, { recursive: true });

		for (const { width, height } of VIEWPORTS) {
			await page.setViewportSize({ width, height });
			await startClean(page);
			await page.goto('/notes/new');
			await page.waitForFunction(() => document.querySelector('[data-slot="app-shell"]') !== null);

			await page.keyboard.type(SAMPLE);
			// Wait for the save to land so the status reads "Saved", not "Saving…".
			await expect(page.getByTestId('editor-status')).toHaveText('Saved');

			for (const dir of outDirs) {
				await page.screenshot({ path: path.join(dir, `editor-${width}.png`) });
			}
		}
	});

	test('the save-error state at 1280', async ({ page }) => {
		const outDirs = [SHOT_DIR];
		if (process.env.SCREENSHOT_OUT_DIR) outDirs.push(path.resolve(process.env.SCREENSHOT_OUT_DIR));
		for (const dir of outDirs) fs.mkdirSync(dir, { recursive: true });

		await page.setViewportSize({ width: 1280, height: 800 });
		await startClean(page);
		await page.goto('/notes/new');
		await page.waitForFunction(() => document.querySelector('[data-slot="app-shell"]') !== null);

		await page.keyboard.type('Some text that will fail to save');
		await expect(page.getByTestId('editor-status')).toHaveText('Saved');

		// Force a quota failure on the next write, the way a full disk would.
		await page.evaluate(() => {
			const original = IDBObjectStore.prototype.put;
			IDBObjectStore.prototype.put = function patched(
				this: IDBObjectStore
			): IDBRequest<IDBValidKey> {
				throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
			} as typeof IDBObjectStore.prototype.put;
			(window as unknown as { __restorePut: () => void }).__restorePut = () => {
				IDBObjectStore.prototype.put = original;
			};
		});

		await page.keyboard.type(' and this edit cannot be stored');
		await expect(page.getByTestId('editor-save-error')).toBeVisible();
		// The text is still on screen, which is the whole point of the alert.
		await expect(page.getByRole('textbox', { name: 'Note' })).toHaveValue(
			'Some text that will fail to save and this edit cannot be stored'
		);

		for (const dir of outDirs) {
			await page.screenshot({ path: path.join(dir, 'editor-error-1280.png') });
		}
	});
});
