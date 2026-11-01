import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { seedNote, seedNotes } from './helpers/seed';

/**
 * Screenshot capture for the Markdown preview (#9). Opt-in, same pattern as the
 * other shot specs: `SCREENSHOTS=1 pnpm test:e2e`.
 *
 * Writes the three viewports the epic requires:
 *
 * - `preview-1280.png` — editor and preview side by side, both live;
 * - `preview-768.png`  — the Preview tab at tablet width;
 * - `preview-375.png`  — the Preview tab at phone width.
 *
 * Each shot shows a note with rich Markdown, so the review of the PR can judge
 * the typography rather than a placeholder. `SCREENSHOT_OUT_DIR` copies them to
 * the harness run directory.
 */
const SHOT_DIR = path.resolve(import.meta.dirname, '../../docs/screenshots');

/** Markdown that exercises headings, lists, tasks, a table, a quote and code. */
const SAMPLE = [
	'# Groceries',
	'',
	'Some **bold**, some *italic*, some ~~struck~~.',
	'',
	'- [ ] milk',
	'- [x] eggs',
	'- [ ] sourdough starter',
	'',
	'| item | qty |',
	'| :--- | --: |',
	'| bread | 2 |',
	'| olives | 250 g |',
	'',
	'> The market closes at 8 on Thursdays.',
	'',
	'```js',
	"const list = ['milk', 'eggs'];",
	'```',
	'',
	'See https://example.com/market for hours.'
].join('\n');

const VIEWPORTS = [
	{ width: 375, height: 667 },
	{ width: 768, height: 1024 },
	{ width: 1280, height: 800 }
];

test.describe('preview screenshots', () => {
	test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to capture screenshots');

	test('the preview at 375, 768 and 1280', async ({ page }) => {
		const outDirs = [SHOT_DIR];
		if (process.env.SCREENSHOT_OUT_DIR) outDirs.push(path.resolve(process.env.SCREENSHOT_OUT_DIR));
		for (const dir of outDirs) fs.mkdirSync(dir, { recursive: true });

		const [note] = await seedNotes(page, [seedNote(1, SAMPLE, '2026-10-31T12:00:00.000Z')]);

		for (const { width, height } of VIEWPORTS) {
			await page.setViewportSize({ width, height });
			await page.goto(`/notes/${note.id}`);
			await page.waitForFunction(() => document.querySelector('[data-slot="app-shell"]') !== null);

			if (width < 1280) {
				// Below `xl` one pane at a time: show the preview, which is what this
				// issue adds. The Edit tab is the default, so switch explicitly.
				await page.getByRole('tab', { name: 'Preview' }).click();
				await expect(page.getByTestId('preview-pane')).toBeVisible();
			} else {
				// At `xl` both panes are up; assert it before shooting so a shot of a
				// broken layout cannot be committed silently.
				await expect(page.getByTestId('markdown-preview').locator('h1')).toBeVisible();
			}

			await expect(page.getByTestId('markdown-preview').locator('table')).toContainText('bread');

			for (const dir of outDirs) {
				await page.screenshot({ path: path.join(dir, `preview-${width}.png`) });
			}
		}
	});
});
