import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { seedNote, seedNotes, waitForList } from './helpers/seed';

/**
 * Screenshot capture for PR evidence of #8. Opt-in, same pattern as the other
 * specs: `SCREENSHOTS=1 pnpm test:e2e`.
 *
 * Writes `docs/screenshots/delete-<state>-<width>.png` for both entry points
 * (the Undo toast after deleting from the editor, and the row menu open) at
 * 375×667, 768×1024 and 1280×800, and when `SCREENSHOT_OUT_DIR` is set, a copy
 * of each in that directory too.
 *
 * Each capture runs in the project whose device matches that width — 375 in
 * `mobile`, 768 in `tablet`, 1280 in `desktop` — instead of every project
 * looping all three widths. The difference is not cosmetic: which pointer the
 * browser reports decides whether the row menu is painted on its own
 * (`pointer: coarse`) or only on hover/focus, and a desktop emulation at 375 px
 * would photograph a layout no phone ever shows.
 */
const SHOT_DIR = path.resolve(import.meta.dirname, '../../docs/screenshots');

/** The one viewport each project captures, so no file is written twice. */
const VIEWPORT_BY_PROJECT: Record<string, { width: number; height: number }> = {
	mobile: { width: 375, height: 667 },
	tablet: { width: 768, height: 1024 },
	desktop: { width: 1280, height: 800 }
};

/** Notes whose titles are distinguishable at a glance in a small screenshot. */
function sampleNotes(now: number) {
	return [
		seedNote(
			1,
			'# Groceries\n- [ ] milk\n- [x] eggs\n- [ ] sourdough starter',
			new Date(now - 40 * 60_000).toISOString()
		),
		seedNote(
			2,
			'Weekly plan\nShip the notes list, then the editor with Undo.',
			new Date(now - 5 * 60 * 60_000).toISOString()
		),
		seedNote(
			3,
			'Reading list\n[Epic #1](https://example.com/epic) and the shell PR.',
			new Date(now - 4 * 24 * 60 * 60_000).toISOString()
		)
	];
}

/** Dismisses the storage notice so the capture is about #8, not #10. */
async function startClean(page: Page, notes = sampleNotes(Date.now())) {
	await page.addInitScript(() => {
		window.localStorage.setItem('notes.storageNoticeDismissed', 'true');
	});
	await seedNotes(page, notes);
	await waitForList(page);
	return notes;
}

/** Waits for the toast to finish fading in, so the shot is not half-transparent. */
async function settledToast(page: Page): Promise<void> {
	await expect
		.poll(() =>
			page.evaluate(() => {
				const toast = document.querySelector<HTMLElement>('[data-sonner-toast]');
				return toast === null ? 0 : Number(getComputedStyle(toast).opacity);
			})
		)
		.toBeGreaterThan(0.99);
}

/** The directories a shot is written to: the repo's, plus the report's copy. */
function outputDirs(): string[] {
	const dirs = [SHOT_DIR];
	if (process.env.SCREENSHOT_OUT_DIR) dirs.push(path.resolve(process.env.SCREENSHOT_OUT_DIR));
	for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
	return dirs;
}

/**
 * Takes one screenshot and writes those exact bytes to every destination.
 *
 * Capturing once matters: a second `page.screenshot` a few milliseconds later
 * catches the toast or menu mid-animation, so the repo copy and the report copy
 * would show slightly different frames of the same moment.
 */
async function capture(page: Page, dirs: readonly string[], name: string): Promise<void> {
	const image = await page.screenshot();
	for (const dir of dirs) fs.writeFileSync(path.join(dir, name), image);
}

test.describe('delete screenshots', () => {
	test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to capture screenshots');

	test('the Undo toast after deleting from the editor', async ({ page }, testInfo) => {
		const viewport = VIEWPORT_BY_PROJECT[testInfo.project.name];
		test.skip(viewport === undefined, 'no viewport mapped to this project');
		const dirs = outputDirs();
		await page.setViewportSize(viewport);

		const notes = await startClean(page);
		await page.goto(`/notes/${notes[1].id}`);
		await page.waitForFunction(() => document.querySelector('[data-slot="app-shell"]') !== null);

		await page.getByRole('button', { name: 'Delete note' }).click();
		// The toast is the subject; the shot is taken once it reads "Note deleted".
		await expect(page.locator('[data-sonner-toast]')).toContainText('Note deleted');
		await settledToast(page);
		// Let the layout settle after the navigation back to the list.
		await page.waitForFunction(() => location.pathname === '/');
		await waitForList(page);

		await capture(page, dirs, `delete-toast-${viewport.width}.png`);
	});

	test('the row menu open', async ({ page }, testInfo) => {
		const viewport = VIEWPORT_BY_PROJECT[testInfo.project.name];
		test.skip(viewport === undefined, 'no viewport mapped to this project');
		const dirs = outputDirs();
		await page.setViewportSize(viewport);
		await startClean(page);

		// The trigger is clicked without hovering the row first: hovering also
		// opens the row's date tooltip, which has no place in a screenshot about
		// deleting. The click focuses the trigger, so the row's `focus-within`
		// keeps it painted at every width, and on touch it is painted anyway.
		await page.locator('[data-testid="note-row-menu"]').nth(1).click();
		await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible();

		await capture(page, dirs, `delete-menu-${viewport.width}.png`);
	});
});
