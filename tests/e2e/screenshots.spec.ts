import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Screenshot capture for PR evidence (the epic requires 375×667, 768×1024 and
 * 1280×800 on every UI change). Opt-in: run with `SCREENSHOTS=1 pnpm test:e2e`.
 *
 * Writes `docs/screenshots/shell-<route>-<width>.png` and, when
 * SCREENSHOT_OUT_DIR is set, an extra copy of each file in that directory.
 */
const SHOT_DIR = path.resolve(import.meta.dirname, '../../docs/screenshots');
const VIEWPORTS = [
	{ width: 375, height: 667 },
	{ width: 768, height: 1024 },
	{ width: 1280, height: 800 }
];
const ROUTES = [
	{ slug: 'list', path: '/' },
	{ slug: 'note', path: '/notes/some-id' }
];

test.describe('screenshots', () => {
	test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to capture screenshots');

	test('shell on both routes at 375, 768 and 1280', async ({ page }) => {
		const outDirs = [SHOT_DIR];
		if (process.env.SCREENSHOT_OUT_DIR) outDirs.push(path.resolve(process.env.SCREENSHOT_OUT_DIR));
		for (const dir of outDirs) fs.mkdirSync(dir, { recursive: true });

		for (const { width, height } of VIEWPORTS) {
			await page.setViewportSize({ width, height });
			for (const route of ROUTES) {
				await page.goto(route.path);
				await expect(page.getByRole('heading', { level: 1, name: 'Notes' })).toBeVisible();
				for (const dir of outDirs) {
					await page.screenshot({ path: path.join(dir, `shell-${route.slug}-${width}.png`) });
				}
			}
		}
	});
});
