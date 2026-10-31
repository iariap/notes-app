import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Screenshot capture for PR evidence of the one-time storage notice (#10).
 * Opt-in, same as the shell screenshots: run with `SCREENSHOTS=1 pnpm test:e2e`.
 *
 * Writes `docs/screenshots/notice-<width>.png` and, when `SCREENSHOT_OUT_DIR` is
 * set, an extra copy of each file in that directory.
 */
const SHOT_DIR = path.resolve(import.meta.dirname, '../../docs/screenshots');
const VIEWPORTS = [
	{ width: 375, height: 667 },
	{ width: 768, height: 1024 },
	{ width: 1280, height: 800 }
];

test.describe('storage notice screenshots', () => {
	test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to capture screenshots');

	test('the notice at 375, 768 and 1280', async ({ page }) => {
		const outDirs = [SHOT_DIR];
		if (process.env.SCREENSHOT_OUT_DIR) outDirs.push(path.resolve(process.env.SCREENSHOT_OUT_DIR));
		for (const dir of outDirs) fs.mkdirSync(dir, { recursive: true });

		for (const { width, height } of VIEWPORTS) {
			await page.setViewportSize({ width, height });
			// The test project sets its own localStorage only per context; a fresh
			// navigation here always starts from a first visit.
			await page.goto('/');
			await expect(page.getByTestId('storage-notice')).toBeVisible();
			for (const dir of outDirs) {
				await page.screenshot({ path: path.join(dir, `notice-${width}.png`) });
			}
		}
	});
});
