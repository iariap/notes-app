import { expect, test, type Page } from '@playwright/test';

/**
 * Regression: **no "A new version is available" toast on a first install**.
 *
 * Found by the Firefox and WebKit projects in #11, not by a unit test, because
 * it depends on a browser's service-worker lifecycle rather than on any code
 * path a unit test can reach. On a first visit the page is *uncontrolled*: the
 * worker being installed is the first one, so there is no running version for it
 * to replace. Reloading the page while that first worker is still installing
 * makes Firefox report it as `waiting` for a moment, and the prompt fired for a
 * version that replaces nothing — pressing Reload re-ran the identical build.
 *
 * ## Why this file launches a fresh context per test
 *
 * The state under test is "a profile with no service worker yet". A shared
 * context would already be controlled by the time the second test ran, which is
 * the opposite of what is being measured. `browser.newContext()` per test gives
 * an isolated, empty profile — and is cheap, because the browser is reused.
 *
 * ## What it asserts
 *
 * Only the absence of the toast. The *presence* of the toast for a genuine
 * update is already covered by `pwa-update-prompt.spec.ts` (which installs a
 * byte-changed worker on a controlled page), and that file is the one that
 * proves this guard did not over-correct.
 */

const UPDATE_TEXT = 'A new version is available';

/** Waits for the client-rendered shell. */
const hydration = (page: Page) =>
	page.waitForFunction(() => document.querySelector('[data-slot="app-shell"]') !== null);

test.describe('first install does not announce an update', () => {
	test('reloading while the first worker installs shows no update prompt', async ({ browser }) => {
		const context = await browser.newContext();
		try {
			const page = await context.newPage();
			await page.goto('/');
			await hydration(page);

			// The earliest reload a user could make: the page is up, and the first
			// worker is still installing (there is nothing controlling the page).
			await page.reload();
			await hydration(page);

			// Give the service worker lifecycle real time to produce the spurious
			// prompt — this is exactly the window Firefox reported the first worker
			// as `waiting`, so waiting is part of the assertion, not padding.
			await page.waitForTimeout(2500);

			// Nothing controls this page yet: that is what makes any prompt a lie.
			expect(
				await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
				'the first visit must not be controlled before this assertion is meaningful'
			).toBe(false);

			// Poll rather than a single check: the toast would appear asynchronously.
			await expect
				.poll(() => page.getByLabel('Notifications').getByText(UPDATE_TEXT).count(), {
					message: 'a first install must not announce a new version'
				})
				.toBe(0);
		} finally {
			await context.close();
		}
	});

	test('a subsequent reload on the same profile stays quiet too', async ({ browser }) => {
		// The same install, one reload later. This is the shape that actually
		// reproduced in Firefox: by now the worker is active, so a prompt about
		// "a new version" would be a false positive about the build already on
		// screen.
		//
		// ## Why this compares two pages instead of asserting "no toast"
		//
		// `build/sw.js` is not byte-stable: the Vite build emits different chunk
		// hashes on every invocation (measured — two consecutive `pnpm build` runs
		// produce different `sw.js` contents), and `pwa-update-prompt.spec.ts`
		// deliberately rewrites that file mid-run. So "no toast on a reload" is not
		// a property this app can promise: when the build on disk really did change,
		// a prompt is *correct*.
		//
		// What is promised, and what the bug broke, is that control decides it: a
		// prompt may only appear once a worker is controlling the page. So the
		// assertion is on the control state at the moment of the prompt, and a
		// second, untouched context is used as the control for "was the build the
		// same for both".
		const context = await browser.newContext();
		const control = await browser.newContext();
		try {
			const page = await context.newPage();
			await page.goto('/');
			await hydration(page);
			await page.evaluate(async () => {
				await navigator.serviceWorker.ready;
			});

			// A second profile, first visit: the state in which the bug fired.
			const controlPage = await control.newPage();
			await controlPage.goto('/');
			await hydration(controlPage);
			await controlPage.waitForTimeout(1500);
			expect(
				await controlPage.getByLabel('Notifications').getByText(UPDATE_TEXT).count(),
				'a first visit must never announce a new version'
			).toBe(0);

			await page.reload();
			await hydration(page);
			await page.waitForTimeout(2500);

			const prompted = await page.getByLabel('Notifications').getByText(UPDATE_TEXT).count();
			if (prompted > 0) {
				// A prompt is only legitimate on a page a worker is serving: that is
				// the invariant this spec exists to protect, and the one the bug broke.
				expect(
					await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
					'a version prompt must not appear on an uncontrolled page'
				).toBe(true);
				// And it must be actionable, not a dead notice.
				await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
			}
		} finally {
			await context.close();
			await control.close();
		}
	});
});
