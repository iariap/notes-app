import { expect, test, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The new-version prompt, against a real waiting service worker.
 *
 * A waiting worker is produced for real, not simulated: the spec appends a
 * comment to the built `build/sw.js`, asks the registration to `update()`, and
 * the browser installs that second script. With `registerType: 'prompt'` the
 * new worker does not call `skipWaiting`, so with a controlled page it stays in
 * `waiting` — exactly the state the toast exists for. Everything downstream
 * (the toast, its copy, the Reload action, the absence of an automatic reload)
 * is production code.
 *
 * The spec mutates a build artifact, so it is serial and restores the file
 * afterwards (the marker is a comment, so even a crashed run leaves a working
 * build). For the same reason it runs in a single project: Playwright would
 * otherwise run it in three projects in parallel against one `build/`, and one
 * project's rewrite would abort another's install. Nothing here depends on the
 * viewport — it is a service worker and a toast — so `desktop` alone is enough.
 */
test.describe.configure({ mode: 'serial' });

const BUILD_SW = path.resolve(import.meta.dirname, '../../build/sw.js');
const MARKER = '\n// e2e: a newer build of this service worker\n';

const hydration = (page: Page) =>
	page.waitForFunction(() => document.querySelector('[data-slot="app-shell"]') !== null);

/**
 * Loads the app, then reloads so the document is *controlled* by the active
 * worker. Without that, a newly installed worker activates immediately (nothing
 * is using the old one) instead of waiting, and the prompt never fires — which
 * is correct browser behaviour, not a bug in the app.
 */
async function loadControlled(page: Page): Promise<void> {
	await page.goto('/');
	await hydration(page);
	await page.evaluate(async () => {
		const registration = await navigator.serviceWorker.ready;
		if (!registration.active) throw new Error('service worker never activated');
	});
	await page.reload();
	await hydration(page);
	expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

/** Publishes a byte-different but still valid service worker and installs it. */
async function installNewerWorker(page: Page, original: string): Promise<void> {
	await writeFile(BUILD_SW, original + MARKER, 'utf8');
	await page.evaluate(async () => {
		const registration = await navigator.serviceWorker.getRegistration();
		await registration?.update();
	});
}

const waitingState = (page: Page) =>
	page.evaluate(async () => {
		const registration = await navigator.serviceWorker.getRegistration();
		return registration?.waiting?.state ?? 'none';
	});

test.describe('new version prompt', () => {
	let original: string;

	test.beforeEach(() => {
		// Mutates `build/sw.js`, which the three projects share: run it once.
		test.skip(test.info().project.name !== 'desktop', 'mutates a shared build artifact');
	});

	test.beforeEach(async () => {
		original = await readFile(BUILD_SW, 'utf8');
	});

	test.afterEach(async () => {
		// Leave the build exactly as it was found, even when an assertion threw.
		if (original !== undefined) await writeFile(BUILD_SW, original, 'utf8');
	});

	test('a waiting worker shows a toast with Reload and never reloads on its own', async ({
		page
	}) => {
		let navigations = 0;
		page.on('framenavigated', (frame) => {
			if (frame === page.mainFrame()) navigations += 1;
		});

		await loadControlled(page);
		const beforeUpdate = navigations;

		await installNewerWorker(page, original);

		await expect(
			page.getByLabel('Notifications').getByText('A new version is available')
		).toBeVisible({ timeout: 30_000 });
		await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();

		// The worker really is waiting: that is why the prompt appeared.
		expect(await waitingState(page)).toBe('installed');

		// The whole point: the prompt appears and the page does not move.
		await page.waitForTimeout(1500);
		expect(navigations).toBe(beforeUpdate);
		await expect(page.getByRole('heading', { level: 1, name: 'Notes' })).toBeVisible();
	});

	test('Reload applies the update when the user presses it', async ({ page }) => {
		await loadControlled(page);
		await installNewerWorker(page, original);

		const reload = page.getByRole('button', { name: 'Reload' });
		await expect(reload).toBeVisible({ timeout: 30_000 });
		expect(await waitingState(page)).toBe('installed');

		await reload.click();

		// After the click the page reloads and the new worker takes over, so
		// nothing is left waiting.
		await hydration(page);
		await expect(page.getByRole('heading', { level: 1, name: 'Notes' })).toBeVisible();
		await expect.poll(() => waitingState(page)).toBe('none');
	});

	test('the toast stays until the user acts on it', async ({ page }) => {
		await loadControlled(page);
		await installNewerWorker(page, original);

		const notice = page.getByLabel('Notifications').getByText('A new version is available');
		await expect(notice).toBeVisible({ timeout: 30_000 });

		// Toasts auto-dismiss after a few seconds by default; a version notice
		// must still be there when the user comes back to the tab.
		await page.waitForTimeout(7000);
		await expect(notice).toBeVisible();
		await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
	});
});
