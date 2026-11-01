import { expect, type Page } from '@playwright/test';

/**
 * Keyboard helpers that behave the same in every engine the matrix runs.
 *
 * ## Why `Tab` is not `Tab` everywhere
 *
 * WebKit is Safari's engine, and Safari on macOS does **not** put links in
 * plain `Tab` order: only form controls take focus with `Tab`, and links need
 * `Option+Tab` (Playwright's `Alt+Tab`). That is a browser preference, not
 * something the app can fix — adding `tabindex="0"` to every link would fight
 * the platform and override the OS setting Safari exposes for exactly this.
 *
 * Measured on this build (Playwright 1.64, WebKit 27.2), from `<body>` at
 * 1280×800:
 *
 * | key       | WebKit                                     | Chromium              |
 * |-----------|--------------------------------------------|-----------------------|
 * | `Tab`     | stays on `<body>` ×10                      | skip → header → list  |
 * | `Alt+Tab` | skip → header → New note → notice → row    | (skips the same)      |
 *
 * So the traversal tests press the key **that engine binds to tabbing**. The
 * assertion is unchanged — the same controls, in the same order, with no
 * pointer — and nothing is skipped or relaxed. Where a spec cares about a *form
 * control* receiving focus, plain `Tab` is correct in all three engines and is
 * used directly.
 *
 * ## Why the layout predicates read the viewport, not the project name
 *
 * The three original projects happened to line up (`mobile` = 375, `tablet` =
 * 768, `desktop` = 1280), so `testInfo.project.name === 'mobile'` also happened
 * to mean "single column". #11 added `desktop-firefox`, `desktop-webkit` and
 * `mobile-webkit`: a project name now says nothing about the viewport, and a
 * name check silently asserts the wrong layout instead of failing. These
 * predicates ask the question the assertion actually has.
 */

/** The key this engine binds to "move focus to the next element". */
export function keyboardNavigationKey(page: Page): string {
	return page.context().browser()?.browserType().name() === 'webkit' ? 'Alt+Tab' : 'Tab';
}

/** Advances focus one stop, using the key the current engine binds to tabbing. */
export async function pressTab(page: Page): Promise<void> {
	await page.keyboard.press(keyboardNavigationKey(page));
}

/** Advances focus `count` stops. */
export async function pressTabTimes(page: Page, count: number): Promise<void> {
	const key = keyboardNavigationKey(page);
	for (let index = 0; index < count; index += 1) await page.keyboard.press(key);
}

/** The narrow single-column layout: below the `md` breakpoint. */
export function isNarrow(page: Page): boolean {
	return (page.viewportSize()?.width ?? 0) < 768;
}

/** The side-by-side editor + preview layout, which starts at `xl`. */
export function isSideBySide(page: Page): boolean {
	return (page.viewportSize()?.width ?? 0) >= 1280;
}

/**
 * A finger-first device: `(pointer: coarse)`, where hover does not exist. Both
 * `Pixel 7` (Chromium) and `iPhone 14` (WebKit) report it; a desktop emulation
 * narrowed to 375 px does not. That distinction — not the project name — is
 * what decides whether the row menu paints itself.
 */
export function hasCoarsePointer(page: Page): Promise<boolean> {
	return page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
}

/** Waits for the client-rendered shell (the app is a client-only SPA). */
export function hydration(page: Page): Promise<unknown> {
	return page.waitForFunction(() => document.querySelector('[data-slot="app-shell"]') !== null);
}

/** Horizontal overflow of the document, in pixels. `<= 0` means none. */
export function horizontalOverflow(page: Page): Promise<number> {
	return page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
}

/** Asserts the document has no horizontal overflow. */
export async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
	const overflow = await horizontalOverflow(page);
	expect(
		overflow,
		`${label}: the document overflows horizontally by ${overflow} px`
	).toBeLessThanOrEqual(0);
}
