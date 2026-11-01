import { expect, test } from '@playwright/test';
import { hydration, isSideBySide } from '../helpers/keyboard';
import { seedNote, seedNotes, waitForList } from '../helpers/seed';
import { RICH_BODY, editorStatus, expectNoOverflowWithScreenshot, sweepWidths } from './support';

/**
 * Story 6 — **Markdown with live preview**.
 *
 * Epic #1: "GFM; preview updates while typing; side-by-side on wide screens,
 * Edit/Preview tabs on narrow ones; all HTML sanitized (no script execution);
 * links open in a new tab with `rel=\"noopener noreferrer\"`."
 *
 * ## Reuse
 *
 * #9's `markdown-preview.spec.ts` is the authority for every clause: it proves
 * each GFM feature, the live update, both layouts, all seven XSS payloads and
 * the link attributes. The sanitizer itself is security-reviewed
 * (`src/lib/markdown/render.ts`, untouched by #11) and unit-tested against a
 * payload table. Duplicating any of that here would be a second, weaker copy.
 *
 * What this file adds: the two preview *layouts* are asserted by breakpoint
 * rather than by project name (so the engines #11 added are covered), and both
 * preview states get the five-width sweep — the wide table in `RICH_BODY` is
 * the most likely thing in the app to push a 320 px page sideways.
 */

test.describe('story 6 — Markdown with live preview', () => {
	test('AC1: the preview updates while typing, in both layouts', async ({ page }) => {
		await page.goto('/notes/new');
		await hydration(page);
		const body = page.getByRole('textbox', { name: 'Note' });
		await expect(body).toBeFocused();

		await page.keyboard.type('# Heading here');
		// Below `xl` the preview lives behind its tab; at `xl` it is already up.
		if (!isSideBySide(page)) await page.getByRole('tab', { name: 'Preview' }).click();
		await expect(page.getByTestId('markdown-preview').locator('h1')).toHaveText('Heading here');

		// Switching back to Edit focuses the tab, not the textarea, so the text
		// has to be appended through the textarea itself — typed into the tab it
		// would go nowhere, and the preview would (correctly) never change.
		if (!isSideBySide(page)) await page.getByRole('tab', { name: 'Edit' }).click();
		await body.focus();
		await body.evaluate((element) => {
			const area = element as HTMLTextAreaElement;
			area.setSelectionRange(area.value.length, area.value.length);
		});
		await page.keyboard.type('\n\nwith a **strong** word');
		if (!isSideBySide(page)) await page.getByRole('tab', { name: 'Preview' }).click();
		await expect(page.getByTestId('markdown-preview').locator('strong')).toHaveText('strong');
	});

	test('AC2: side by side at 1280 px and up; tabs below it', async ({ page }) => {
		const [note] = await seedNotes(page, [seedNote(1, RICH_BODY, new Date().toISOString())]);
		await waitForList(page);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);

		if (isSideBySide(page)) {
			await expect(page.getByRole('textbox', { name: 'Note' })).toBeVisible();
			await expect(page.getByTestId('preview-pane')).toBeVisible();
			// The control is not offered where the layout already shows both.
			await expect(page.getByTestId('editor-view-tabs')).toBeHidden();
		} else {
			await expect(page.getByTestId('editor-view-tabs')).toBeVisible();
			await expect(page.getByTestId('preview-pane')).toBeHidden();
			await page.getByRole('tab', { name: 'Preview' }).click();
			await expect(page.getByTestId('preview-pane')).toBeVisible();
		}
	});

	test('AC3: links open in a new tab with rel="noopener noreferrer"', async ({ page }) => {
		const [note] = await seedNotes(page, [seedNote(1, RICH_BODY, new Date().toISOString())]);
		await waitForList(page);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);
		if (!isSideBySide(page)) await page.getByRole('tab', { name: 'Preview' }).click();

		const link = page
			.getByTestId('markdown-preview')
			.locator('a', { hasText: 'https://example.com' });
		await expect(link).toHaveAttribute('target', '_blank');
		await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
	});

	test('AC4: hostile Markdown renders inert in the shipped bundle', async ({ page }) => {
		// One payload here, as an end-to-end smoke check that the sanitizer is in
		// the build the user runs. #9 owns the full seven-payload table; if this
		// one ever fails, that spec fails too, and it is the one that says why.
		await page.addInitScript(() => {
			(window as unknown as { __executions: string[] }).__executions = [];
			window.alert = (message?: unknown) => {
				(window as unknown as { __executions: string[] }).__executions.push(
					`alert:${String(message)}`
				);
			};
		});
		const [note] = await seedNotes(page, [
			seedNote(1, '<img src=x onerror=alert("xss")>\n\nreadable text', new Date().toISOString())
		]);
		await waitForList(page);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);
		if (!isSideBySide(page)) await page.getByRole('tab', { name: 'Preview' }).click();
		await expect(page.getByTestId('preview-pane')).toBeVisible();
		await page.waitForTimeout(200);

		expect(
			await page.evaluate(() => (window as unknown as { __executions: string[] }).__executions)
		).toEqual([]);
		expect(
			await page
				.getByTestId('markdown-preview')
				.evaluate((element) =>
					[...element.querySelectorAll('*')].some((node) => node.tagName.toLowerCase() === 'script')
				)
		).toBe(false);
		await expect(page.getByTestId('markdown-preview')).toContainText('readable text');
	});

	test('AC5: no horizontal overflow in either preview layout, at 320 through 1920 px', async ({
		page
	}, testInfo) => {
		const [note] = await seedNotes(page, [seedNote(1, RICH_BODY, new Date().toISOString())]);
		await waitForList(page);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);

		// Edit view. `sweepWidths` ends at 1920 px, which is the wide layout, so
		// the tabbed part has to start from an explicit below-`xl` size again.
		if (!isSideBySide(page)) await page.getByRole('tab', { name: 'Edit' }).click();
		await sweepWidths(page, testInfo, 'story-6 preview: edit view');

		// Preview view: at 320 px this is where `RICH_BODY`'s table has to fit.
		// The tab control only exists below `xl`, so the sweep runs there and the
		// two wide widths are swept separately, with both panes already up.
		for (const width of [320, 375, 768] as const) {
			await page.setViewportSize({ width, height: 800 });
			await page.getByRole('tab', { name: 'Preview' }).click();
			await expect(page.getByTestId('preview-pane')).toBeVisible();
			await expectNoOverflowWithScreenshot(page, testInfo, 'story-6 preview: preview view', width);
			await page.getByRole('tab', { name: 'Edit' }).click();
		}
		for (const width of [1280, 1920] as const) {
			await page.setViewportSize({ width, height: 800 });
			await expect(page.getByTestId('preview-pane')).toBeVisible();
			await expectNoOverflowWithScreenshot(page, testInfo, 'story-6 preview: preview view', width);
		}
	});

	test('AC6: a note is still saved while the preview is on screen', async ({ page }) => {
		await page.goto('/notes/new');
		await hydration(page);
		await page.keyboard.type('# Saved with a preview');
		await expect(editorStatus(page)).toHaveText('Saved');

		await page.reload();
		await hydration(page);
		await expect(page.getByRole('textbox', { name: 'Note' })).toHaveValue('# Saved with a preview');
	});
});
