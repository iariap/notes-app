import { expect, test, type Page } from '@playwright/test';

/**
 * The app must be fully usable with no network after one online visit — on the
 * list route and on a deep link (`/notes/<id>`), which is the case that breaks
 * when a service worker only precaches the root document.
 *
 * These specs run against the real static build (`pnpm build && pnpm preview`);
 * the dev server has no service worker on purpose.
 */

const hydration = (page: Page) =>
	page.waitForFunction(() => document.querySelector('[data-slot="app-shell"]') !== null);

/** Registers, activates and fills the precache, then reports the cache state. */
async function primeServiceWorker(page: Page): Promise<string> {
	await hydration(page);
	const scope = await page.evaluate(async () => {
		const registration = await navigator.serviceWorker.ready;
		// The precache is written during install; `ready` already implies active,
		// so a real cache entry proves the offline path has something to serve.
		const cache = await caches.open((await caches.keys())[0]);
		const keys = await cache.keys();
		if (keys.length === 0) throw new Error('service worker cache is empty');
		return registration.scope;
	});
	return scope;
}

/**
 * `context.setOffline(true)` is per browser context, so every navigation after
 * it fails at the network layer — exactly the condition being tested.
 */
test.describe('offline', () => {
	test('the list route still renders after reload with the network off', async ({
		page,
		context
	}) => {
		await page.goto('/');
		await primeServiceWorker(page);

		// Prove the app is the real app before going offline.
		await expect(page.getByRole('heading', { level: 1, name: 'Notes' })).toBeVisible();

		await context.setOffline(true);
		await page.reload();

		await hydration(page);
		await expect(page.getByRole('heading', { level: 1, name: 'Notes' })).toBeVisible();
		await expect(page.getByRole('region', { name: 'Notes' })).toBeVisible();

		// And the network really is off: a fresh fetch cannot reach the server.
		await expect(
			page.evaluate(async () => {
				try {
					await fetch('/_app/version.json', { cache: 'no-store' });
					return 'reachable';
				} catch {
					return 'offline';
				}
			})
		).resolves.toBe('offline');
	});

	test('a deep link renders after reload with the network off', async ({ page, context }) => {
		// One online visit is what installs the service worker and its precache.
		await page.goto('/');
		await primeServiceWorker(page);

		await context.setOffline(true);
		// Hard navigation to a path that exists only as a client route: the
		// service worker's navigateFallback must answer with the app shell.
		await page.goto('/notes/some-id');

		await hydration(page);
		await expect(page.getByRole('heading', { level: 1, name: 'Notes' })).toBeVisible();
		// The shell routed to the editor pane with the id from the URL, which is
		// not stored: the editor says so instead of rendering a blank box.
		await expect(page.getByTestId('editor-missing')).toBeVisible();

		// A reload of that deep link offline keeps working too.
		await page.reload();
		await hydration(page);
		await expect(page.getByRole('heading', { level: 1, name: 'Notes' })).toBeVisible();
		await expect(page.getByTestId('editor-missing')).toBeVisible();
	});

	test('the notice dismissal survives a reload with the network off', async ({ page, context }) => {
		await page.goto('/');
		await primeServiceWorker(page);

		await page.getByRole('button', { name: 'OK, got it' }).click();
		await expect(page.getByTestId('storage-notice')).toHaveCount(0);

		await context.setOffline(true);
		await page.reload();
		await hydration(page);

		await expect(page.getByTestId('storage-notice')).toHaveCount(0);
	});
});
