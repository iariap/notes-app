import { expect, test, type Page } from '@playwright/test';
import { hydration } from '../helpers/keyboard';
import { sweepWidths } from './support';

/**
 * Story 8 — **Installable, offline**.
 *
 * Epic #1: "web app manifest + service worker; the app loads with no network
 * after the first visit; requests persistent storage."
 *
 * ## Reuse
 *
 * The manifest's fields and icons, the service worker's activation and its
 * precache, and the offline reload of both the root and a deep link are proven
 * by #10's `pwa.spec.ts` and `offline.spec.ts` — in Chromium, which is the only
 * engine in this suite whose service worker Playwright can drive the same way.
 *
 * What this file adds: the three clauses asserted **together**, as one journey
 * (manifest → offline reload → persistence request), because they are one user
 * story and "the app still loads" is only meaningful if the manifest and the
 * worker are both present. It also asserts the persistence request is actually
 * made, which no earlier spec checked from the outside.
 */

/** Waits until a service worker is registered, active and precaching. */
async function serviceWorkerReady(page: Page): Promise<void> {
	await hydration(page);
	await page.evaluate(async () => {
		const registration = await navigator.serviceWorker.ready;
		const worker = registration.active ?? registration.waiting ?? registration.installing;
		if (!worker) throw new Error('the registration has no worker');
		const cache = await caches.open((await caches.keys())[0]);
		// A real cache entry is what proves the offline path has something to
		// serve; `ready` alone only proves the worker activated.
		if ((await cache.keys()).length === 0) throw new Error('the precache is empty');
	});
}

test.describe('story 8 — Installable, offline', () => {
	test('AC1: the manifest is linked, served, and its icons resolve', async ({ page, request }) => {
		await page.goto('/');

		const href = await page.locator('link[rel="manifest"]').getAttribute('href');
		expect(href).toBe('/manifest.webmanifest');

		const response = await request.get(String(href));
		expect(response.status()).toBe(200);
		expect(response.headers()['content-type']).toContain('application/manifest+json');

		const manifest = await response.json();
		expect(manifest).toMatchObject({
			name: 'Notes',
			start_url: '/',
			display: 'standalone'
		});
		// Every declared icon must be reachable, not just declared.
		for (const icon of manifest.icons as { src: string }[]) {
			expect((await request.get(icon.src)).status(), icon.src).toBe(200);
		}
	});

	test('AC2: a service worker registers and activates', async ({ page }) => {
		await page.goto('/');
		await serviceWorkerReady(page);

		const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
		expect(scope).toBe(`${new URL(page.url()).origin}/`);
	});

	test('AC3: the app loads with no network after the first visit', async ({ page, context }) => {
		await page.goto('/');
		await serviceWorkerReady(page);
		await expect(page.getByRole('heading', { level: 1, name: 'Notes' })).toBeVisible();

		await context.setOffline(true);
		await page.reload();
		await hydration(page);

		await expect(page.getByRole('heading', { level: 1, name: 'Notes' })).toBeVisible();
		await expect(page.getByRole('region', { name: 'Notes' })).toBeVisible();
		// And the network really is off, so this is not a cached-response illusion.
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

	test('AC4: persistent storage is requested on load', async ({ page }) => {
		// Record the call rather than reading its result: whether the browser
		// grants persistence is a policy decision (and is `false` for an
		// uninstalled site in several engines), while *asking* is the criterion.
		await page.addInitScript(() => {
			const log: string[] = [];
			(window as unknown as { __persistCalls: string[] }).__persistCalls = log;
			const storage = navigator.storage;
			if (!storage || typeof storage.persist !== 'function') return;
			const original = storage.persist.bind(storage);
			storage.persist = async () => {
				log.push('persist');
				return original();
			};
		});
		await page.goto('/');
		await hydration(page);

		await expect
			.poll(() =>
				page.evaluate(
					() => (window as unknown as { __persistCalls: string[] }).__persistCalls.length
				)
			)
			.toBeGreaterThan(0);
	});

	test('AC5: no horizontal overflow on a first visit, with the notice up, 320 through 1920 px', async ({
		page
	}, testInfo) => {
		await page.goto('/');
		await expect(page.getByTestId('storage-notice')).toBeVisible();

		await sweepWidths(page, testInfo, 'story-8 first visit');
	});
});
