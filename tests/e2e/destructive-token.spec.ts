import { expect, test } from '@playwright/test';
import {
	AA_NORMAL_TEXT,
	measureContrast,
	measureContrastOn,
	type ContrastMeasurement
} from './helpers/contrast';
import { hasCoarsePointer, hydration } from './helpers/keyboard';
import { seedNote, seedNotes, waitForList } from './helpers/seed';
import { rowMenu, waitForMenuSettled } from './acceptance/support';

/**
 * Issue #22: `--destructive` must keep WCAG AA even at `/90` transparency.
 *
 * ## The defect this prevents
 *
 * The light-mode token was `oklch(0.577 0.245 27.325)`: **4.77:1** on white,
 * which clears AA's 4.50:1 by a hair. Drawn as `text-destructive/90` it
 * composites 90 % of that colour over white and lands at **4.54:1 in Chromium
 * and Firefox, 4.50:1 in WebKit** (measured: 4.4963) — a real AA miss in one
 * engine, not a rounding artefact. Its green channel is negative, so the colour
 * is out of sRGB gamut and each engine clips it slightly differently, which is
 * why the three do not agree. #11 already hit this as a failing `Alert`
 * description and removed the `/90` rather than fixing the token; #22 is the
 * token fix. The owner approved darkening the shade to
 * `oklch(0.550 0.240 27.325)`: **5.23:1** full strength, **4.93:1** at `/90`.
 *
 * ## Why these assertions
 *
 * - full strength **≥ 4.5:1** — the requirement, against the app's own
 *   `--background`;
 * - the same colour at 90 % **≥ 4.5:1** — the actual regression, and the one
 *   that a check of the opaque token alone cannot catch;
 * - the alpha really is ~0.9 — otherwise a `color-mix` that silently stopped
 *   applying would make the second assertion measure the *opaque* colour and
 *   pass for the wrong reason;
 * - the token resolves to the **approved** shade — pinned by the pixel the
 *   engine paints, not by the source text, so a later edit cannot quietly undo
 *   the fix while the ratios above still happen to clear the floor;
 * - the rendered **controls** that use the token clear AA too, because the
 *   token's own ratio on white is not what a destructive menu item or a hovered
 *   Delete affordance actually draws (the pre-#22 shade was 4.375:1 on the hover
 *   surface — under AA, and invisible to any assertion that only read the token).
 *
 * Every number quoted above was read from a running page in all three engines;
 * see `helpers/contrast.ts` for how.
 */

/**
 * The shade the owner approved for #22. Not to be re-derived or "improved":
 * the point of the equality assertion below is that this decision is recorded
 * somewhere a later change has to confront.
 */
const APPROVED_DESTRUCTIVE = 'oklch(0.550 0.240 27.325)';

/** The value #22 replaced. Kept so "did it actually change?" is asserted too. */
const PREVIOUS_DESTRUCTIVE = 'oklch(0.577 0.245 27.325)';

/**
 * What Tailwind's `/90` modifier produces for a theme colour: 90 % of the token
 * over whatever is behind it. `Alert`'s description used exactly this until
 * #11 removed it, so this is the shape the regression had.
 */
const DESTRUCTIVE_AT_90 = 'color-mix(in oklab, var(--destructive) 90%, transparent)';

/** The token as the running page resolves it, and its painted sRGB pixel. */
async function resolveToken(page: import('@playwright/test').Page): Promise<ContrastMeasurement> {
	return measureContrast(page, 'var(--destructive)', 'var(--background)');
}

test.describe('destructive token (#22)', () => {
	test('the light-mode token is the approved shade', async ({ page }) => {
		await page.goto('/');
		await hydration(page);

		const token = await resolveToken(page);
		// Resolved through a canvas rather than compared as text: the stylesheet is
		// minified at build time (`oklch(57.7% .245 27.325)`), so string equality
		// would be asserting the bundler's formatting, not the colour.
		const approved = await measureContrast(page, APPROVED_DESTRUCTIVE, 'var(--background)');
		const previous = await measureContrast(page, PREVIOUS_DESTRUCTIVE, 'var(--background)');

		expect(
			token.foregroundRgba,
			`--destructive must paint the approved ${APPROVED_DESTRUCTIVE}: ${JSON.stringify(token)}`
		).toEqual(approved.foregroundRgba);

		// And it must be a *change*: if the old value were still in place this
		// assertion would fail even in an engine where both happen to clear AA.
		expect(
			token.foregroundRgba,
			`--destructive still paints the pre-#22 ${PREVIOUS_DESTRUCTIVE}: ${JSON.stringify(token)}`
		).not.toEqual(previous.foregroundRgba);
	});

	test('destructive text clears AA at full strength and at 90% opacity', async ({ page }) => {
		await page.goto('/');
		await hydration(page);

		const full = await measureContrast(page, 'var(--destructive)', 'var(--background)');
		const ninety = await measureContrast(page, DESTRUCTIVE_AT_90, 'var(--background)');

		// The issue's numbers are "on white"; assert that assumption instead of
		// inheriting it from the theme.
		expect(full.backgroundRgb, '--background must be opaque white').toEqual([255, 255, 255]);

		expect(
			ninety.foregroundAlpha,
			`the /90 composite must really be translucent, not the opaque token: ${JSON.stringify(ninety)}`
		).toBeCloseTo(0.9, 1);

		expect(
			full.ratio,
			`--destructive on --background must clear AA: ${JSON.stringify(full)}`
		).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);

		expect(
			ninety.ratio,
			`--destructive at 90% over white must clear AA: ${JSON.stringify(ninety)}`
		).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);

		// Headroom, not just the floor. A gate at exactly 4.50:1 would accept a
		// token sitting on it again, which is how #22 happened: the old value
		// cleared AA at full strength and still failed at `/90` in WebKit.
		// Measured with the approved shade: 5.23:1 full, 4.93:1 at `/90`.
		expect(full.ratio, `full-strength headroom: ${JSON.stringify(full)}`).toBeGreaterThan(5);
		expect(ninety.ratio, `headroom at /90: ${JSON.stringify(ninety)}`).toBeGreaterThan(4.7);
	});

	/**
	 * The token on the surfaces that actually use it, measured on the rendered
	 * controls rather than on the token.
	 *
	 * `hover:text-destructive` on the editor's Delete affordance is the state that
	 * matters: it sits on the row's hover background, not on white. Measured with
	 * the **old** token it was **4.375:1** — a third AA failure, on a state no
	 * earlier test measured. With the approved shade it is **4.80:1**.
	 *
	 * The hover state is asserted to have *arrived* before measuring where a
	 * pointer can hover. Without that the test can pass by measuring
	 * `--muted-foreground` (the at-rest colour), which is a different,
	 * always-passing question — the first version of this test did exactly that,
	 * and the negative control caught it by passing when the old token was
	 * restored.
	 */
	test('destructive text is AA on the controls that render it', async ({ page }, testInfo) => {
		const [first] = await seedNotes(page, [seedNote(1, 'Measured', new Date().toISOString())]);
		await waitForList(page);

		// The row menu's destructive item, on the menu's own surface.
		await rowMenu(page, 0).click();
		const deleteItem = page.getByRole('menuitem', { name: 'Delete' });
		await deleteItem.waitFor();
		await waitForMenuSettled(page);
		const menuItem = await measureContrastOn(page, deleteItem);
		expect(
			menuItem.ratio,
			`the row menu's Delete item must clear AA @ ${testInfo.project.name}: ${JSON.stringify(menuItem)}`
		).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);

		await page.goto(`/notes/${first.id}`);
		await hydration(page);

		// The pair `hover:text-destructive` produces: the token over the surface
		// the row paints on hover (`--accent`, not white). Asserted as colours
		// rather than through a real hover so it holds on a coarse pointer too,
		// where no hover state exists but the same utility class would still be
		// the one applying if one did. Measured: 4.375:1 before #22, 4.80:1 after.
		const hoverSurface = await measureContrast(page, 'var(--destructive)', 'var(--accent)');
		expect(
			hoverSurface.ratio,
			`--destructive over the hover surface must clear AA @ ${testInfo.project.name}: ${JSON.stringify(hoverSurface)}`
		).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);

		// Where a pointer can hover, prove the class really applies: the rendered
		// button must paint the token, not its at-rest `--muted-foreground`. Without
		// this the assertion above could hold while the utility silently stopped
		// being applied — the first version of this test measured the at-rest
		// colour and passed on the old token.
		if (await hasCoarsePointer(page)) return;
		const deleteButton = page.getByRole('button', { name: 'Delete note' });
		await deleteButton.hover();
		const expected = await measureContrast(page, 'var(--destructive)', 'var(--background)');
		await expect
			.poll(
				async () =>
					(await measureContrastOn(page, deleteButton)).foregroundRgba.slice(0, 3).join(','),
				{
					message: `hover:text-destructive should paint the token on the Delete affordance @ ${testInfo.project.name}`
				}
			)
			.toBe(expected.foregroundRgba.slice(0, 3).join(','));

		const hovered = await measureContrastOn(page, deleteButton);
		expect(
			hovered.ratio,
			`the hovered Delete affordance must clear AA @ ${testInfo.project.name}: ${JSON.stringify(hovered)}`
		).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
	});
});
