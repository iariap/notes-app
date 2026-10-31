import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { seedNote, seedNotes, waitForList } from './helpers/seed';

/**
 * Screenshot capture for PR evidence (the epic requires 375×667, 768×1024 and
 * 1280×800 on every UI change). Opt-in: run with `SCREENSHOTS=1 pnpm test:e2e`.
 *
 * Writes `docs/screenshots/list-<state>-<width>.png` and, when
 * SCREENSHOT_OUT_DIR is set, an extra copy of each file in that directory.
 */
const SHOT_DIR = path.resolve(import.meta.dirname, '../../docs/screenshots');
const VIEWPORTS = [
	{ width: 375, height: 667 },
	{ width: 768, height: 1024 },
	{ width: 1280, height: 800 }
];

/** Six notes whose titles, previews and dates are all visibly distinct. */
function populatedNotes(now: number) {
	return [
		seedNote(
			1,
			'# Groceries\n- [ ] buy milk\n- [x] eggs\n- [ ] sourdough starter',
			new Date(now - 40 * 60_000).toISOString()
		),
		seedNote(
			2,
			'Weekly plan\nShip the notes list, then the editor. Review the storage layer.',
			new Date(now - 5 * 60 * 60_000).toISOString()
		),
		seedNote(
			3,
			'**Release checklist**\nRun `pnpm lint`, `pnpm check`, `pnpm test`, then tag the release.',
			new Date(now - 26 * 60 * 60_000).toISOString()
		),
		seedNote(
			4,
			'Reading list\n[Epic #1](https://example.com/epic) and [the shell PR](https://example.com/pr).',
			new Date(now - 4 * 24 * 60 * 60_000).toISOString()
		),
		seedNote(
			5,
			'Old idea\nStored long ago, so the list shows an absolute date instead of a relative one.',
			new Date(now - 20 * 24 * 60 * 60_000).toISOString()
		),
		seedNote(
			6,
			'Untitled-looking note with only a title',
			new Date(now - 30 * 24 * 60 * 60_000).toISOString()
		)
	];
}

test.describe('screenshots', () => {
	test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to capture screenshots');

	test('notes list: empty and populated at 375, 768 and 1280', async ({ page }) => {
		const outDirs = [SHOT_DIR];
		if (process.env.SCREENSHOT_OUT_DIR) outDirs.push(path.resolve(process.env.SCREENSHOT_OUT_DIR));
		for (const dir of outDirs) fs.mkdirSync(dir, { recursive: true });

		const now = Date.now();

		for (const { width, height } of VIEWPORTS) {
			await page.setViewportSize({ width, height });

			await seedNotes(page, []);
			await waitForList(page);
			await expect(page.getByTestId('note-list-empty')).toBeVisible();
			for (const dir of outDirs) {
				await page.screenshot({ path: path.join(dir, `list-empty-${width}.png`) });
			}

			await seedNotes(page, populatedNotes(now));
			await waitForList(page);
			await expect(page.locator('[data-slot="note-row"]')).toHaveCount(6);
			for (const dir of outDirs) {
				await page.screenshot({ path: path.join(dir, `list-populated-${width}.png`) });
			}
		}
	});
});
