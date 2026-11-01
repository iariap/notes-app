import { expect, test, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { expectNoHorizontalOverflow, horizontalOverflow } from '../helpers/keyboard';
import { seedNote, seedNotes, waitForList, type SeedNote } from '../helpers/seed';

/**
 * Shared fixtures for the v1 acceptance suite (#11).
 *
 * ## What this file is not
 *
 * It is not a second copy of the per-feature helpers in `seed.ts`. It only adds
 * what is specific to acceptance testing: the states *every* route can be in
 * (so responsive and axe sweeps can enumerate them instead of repeating
 * markup), the axe assertion with a settled-animation wait, and the
 * `testInfo.attach` convention used for responsive evidence.
 */

/** The five widths epic #1's responsive rules must hold at, narrowest first. */
export const RESPONSIVE_WIDTHS = [320, 375, 768, 1280, 1920] as const;

/** A body rich enough to exercise every rendering path in one note. */
export const RICH_BODY = [
	'# Weekly plan',
	'',
	'Ship **the list**, then the *editor*.',
	'',
	'- [ ] milk',
	'- [x] eggs',
	'',
	'| item | qty |',
	'| :--- | --: |',
	'| bread | 2 |',
	'',
	'> quoted wisdom',
	'',
	'```js',
	'const answer = 42;',
	'```',
	'',
	'See https://example.com for more.'
].join('\n');

/** Notes whose order and titles are unambiguous. */
export function sampleNotes(now = Date.now()): SeedNote[] {
	return [
		seedNote(1, 'Groceries\n- milk\n- eggs', new Date(now - 60 * 60_000).toISOString()),
		seedNote(2, RICH_BODY, new Date(now - 3 * 60 * 60_000).toISOString()),
		seedNote(
			3,
			'**Old** note\n[docs](https://example.com)',
			new Date(now - 10 * 86_400_000).toISOString()
		)
	];
}

/** Dismisses the one-time storage notice, so a capture shows the app, not #10. */
export async function dismissStorageNotice(page: Page): Promise<void> {
	await page.addInitScript(() => {
		window.localStorage.setItem('notes.storageNoticeDismissed', 'true');
	});
}

/** The editor's textarea, by its accessible label. */
export function editorBody(page: Page): ReturnType<Page['getByRole']> {
	return page.getByRole('textbox', { name: 'Note' });
}

/** The editor's autosave status region. */
export function editorStatus(page: Page): ReturnType<Page['getByTestId']> {
	return page.getByTestId('editor-status');
}

/**
 * Puts the caret at the end of the note body and leaves the textarea focused.
 *
 * An existing note deliberately opens **without** focus, so reading one on a
 * phone does not raise the soft keyboard. A test that types into an opened note
 * therefore has to place focus first — and placing it with `focus()` plus a DOM
 * selection range, rather than a key chord, keeps "end of document" out of the
 * assertion: it is a different combination on every OS, and nothing here is
 * about the shortcut.
 */
export async function placeCaretAtEnd(page: Page): Promise<void> {
	const body = editorBody(page);
	await body.focus();
	await body.evaluate((element) => {
		const area = element as HTMLTextAreaElement;
		area.setSelectionRange(area.value.length, area.value.length);
	});
}

/** The row menu of `index`, opened (a touch device paints it already). */
export function rowMenu(page: Page, index: number): ReturnType<Page['locator']> {
	return page.locator('[data-testid="note-row-menu"]').nth(index);
}

/** The "Note deleted · Undo" toast and its single action. */
export function deleteToast(page: Page): ReturnType<Page['locator']> {
	return page.locator('[data-sonner-toast]').filter({ hasText: 'Note deleted' });
}

export function undoButton(page: Page): ReturnType<Page['locator']> {
	return deleteToast(page).getByRole('button', { name: 'Undo' });
}

/**
 * Waits until a toast has finished fading in.
 *
 * Sonner animates `opacity` from ~0, and an `opacity`-blended button reads as
 * failing contrast while it does. The state a user reads is the settled one, so
 * accessibility sweeps run there. This is a scan-timing wait, not a disabled
 * rule — the same reasoning as #8's spec, restated because this file owns the
 * sweep that depends on it.
 */
export async function waitForToastSettled(page: Page): Promise<void> {
	await expect
		.poll(
			() =>
				page.evaluate(() => {
					const toast = document.querySelector<HTMLElement>('[data-sonner-toast]');
					return toast === null ? 0 : Number(getComputedStyle(toast).opacity);
				}),
			{ message: 'the toast should finish fading in' }
		)
		.toBeGreaterThan(0.99);
}

/** Waits until the row menu's content has finished fading in. */
export async function waitForMenuSettled(page: Page): Promise<void> {
	await expect
		.poll(
			() =>
				page.evaluate(() => {
					const content = document.querySelector<HTMLElement>(
						'[data-slot="dropdown-menu-content"]'
					);
					return content === null ? 0 : Number(getComputedStyle(content).opacity);
				}),
			{ message: 'the row menu should finish fading in' }
		)
		.toBeGreaterThan(0.99);
}

/** One serious/critical axe violation, flattened for a readable assertion. */
interface SeriousViolation {
	id: string;
	impact: string | null;
	context: string;
	nodes: string[];
}

/**
 * Runs axe (WCAG 2 A + AA) and returns only serious/critical violations.
 *
 * The tags match every other axe assertion in the repo (#5–#9), so this sweep
 * cannot pass by asking a weaker question than the feature specs do.
 */
export async function seriousAxeViolations(
	page: Page,
	context: string
): Promise<SeriousViolation[]> {
	const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
	return violations
		.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
		.map((violation) => ({
			id: violation.id,
			impact: violation.impact ?? null,
			context,
			nodes: violation.nodes.map((node) => node.target.join(' '))
		}));
}

/**
 * Asserts no horizontal overflow at `width`, and attaches a screenshot as
 * evidence.
 *
 * The screenshot is the artifact the issue asks for ("save screenshots as test
 * artifacts"): it lands in `test-results/` on a local run and in the uploaded
 * Playwright report on CI, without writing into the repo. It is captured at the
 * size under test, so a failure shows what the engine actually drew rather than
 * a re-render at whatever size the runner happened to have.
 */
export async function expectNoOverflowWithScreenshot(
	page: Page,
	testInfo: TestInfo,
	state: string,
	width: number,
	height = 800
): Promise<void> {
	await page.setViewportSize({ width, height });
	// One frame, so the resize has been laid out before it is measured. A
	// `waitForTimeout` would be a guess; this is the browser's own signal that
	// the frame which includes the resize has been painted.
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));

	await testInfo.attach(`${state} @ ${width}px`, {
		body: await page.screenshot({ fullPage: false }),
		contentType: 'image/png'
	});

	const overflow = await horizontalOverflow(page);
	expect(
		overflow,
		`${state} @ ${width}px overflows horizontally by ${overflow} px`
	).toBeLessThanOrEqual(0);
}

/** Asserts no horizontal overflow at every width in `RESPONSIVE_WIDTHS`. */
export async function sweepWidths(page: Page, testInfo: TestInfo, state: string): Promise<void> {
	for (const width of RESPONSIVE_WIDTHS) {
		await expectNoOverflowWithScreenshot(page, testInfo, state, width);
	}
}

/**
 * Skips the current test unless the project is the canonical one for a
 * behaviour that is viewport- or engine-independent, so a sweep runs once
 * instead of six times.
 *
 * Named rather than inlined so the reason is legible at the call site: this is
 * "the assertion does not vary by project", never "the assertion is unreliable".
 */
export function onceIn(projectName: string, reason: string): void {
	test.skip(test.info().project.name !== projectName, reason);
}

/** Seeds `notes` and waits for the list to settle on them. */
export async function openList(page: Page, notes: readonly SeedNote[]): Promise<void> {
	await seedNotes(page, notes);
	await waitForList(page);
}

export { expectNoHorizontalOverflow };
