import { expect, test, type Page } from '@playwright/test';

/**
 * PWA behaviour, verified against the real static build served by
 * `vite preview` (the Playwright `webServer` runs `pnpm build && pnpm preview`),
 * never against the dev server: in `pnpm dev` there is deliberately no service
 * worker, so any offline assertion here would be meaningless.
 */

/** Waits until the page is hydrated: the shell is client-rendered. */
const hydration = (page: Page) =>
	page.waitForFunction(() => document.querySelector('[data-slot="app-shell"]') !== null);

/**
 * Resolves once a service worker is registered *and* active, with the precache
 * populated. `navigator.serviceWorker.ready` resolves as soon as the worker
 * starts activating, so the state is polled until it reaches `activated`.
 */
const serviceWorkerActive = (page: Page) =>
	page.evaluate(async () => {
		if (!('serviceWorker' in navigator)) throw new Error('no serviceWorker in navigator');
		const registration = await navigator.serviceWorker.ready;
		const worker = registration.active ?? registration.waiting ?? registration.installing;
		if (!worker) throw new Error('registration has no worker');
		if (worker.state === 'activated') {
			return { state: worker.state, scope: registration.scope, scriptURL: worker.scriptURL ?? '' };
		}
		const state = await new Promise<string>((resolveState, rejectState) => {
			const timer = setTimeout(
				() => rejectState(new Error(`service worker stuck in "${worker.state}"`)),
				10_000
			);
			worker.addEventListener('statechange', () => {
				if (worker.state === 'activated') {
					clearTimeout(timer);
					resolveState(worker.state);
				}
			});
		});
		return { state, scope: registration.scope, scriptURL: worker.scriptURL ?? '' };
	});

test.describe('web app manifest', () => {
	test('is linked from the document and served as JSON with the expected fields', async ({
		page,
		request
	}) => {
		await page.goto('/');

		const href = await page.locator('link[rel="manifest"]').getAttribute('href');
		expect(href).toBe('/manifest.webmanifest');

		const response = await request.get(String(href));
		expect(response.status()).toBe(200);
		expect(response.headers()['content-type']).toContain('application/manifest+json');

		const manifest = await response.json();
		expect(manifest).toMatchObject({
			name: 'Notes',
			short_name: 'Notes',
			start_url: '/',
			scope: '/',
			display: 'standalone',
			theme_color: expect.stringMatching(/^#[0-9a-f]{6}$/i),
			background_color: expect.stringMatching(/^#[0-9a-f]{6}$/i)
		});

		// The three icons the issue asks for must be reachable, not just declared.
		const bySize = (size: string, purpose: string) =>
			(manifest.icons as { src: string; sizes: string; purpose?: string }[]).find(
				(icon) => icon.sizes === size && (icon.purpose ?? 'any') === purpose
			);
		const icons = [
			bySize('192x192', 'any'),
			bySize('512x512', 'any'),
			bySize('512x512', 'maskable')
		];
		for (const icon of icons) {
			expect(icon, `manifest icon ${icon?.sizes} ${icon?.purpose}`).toBeDefined();
			const iconResponse = await request.get(icon!.src);
			expect(iconResponse.status(), icon!.src).toBe(200);
			expect(iconResponse.headers()['content-type']).toContain('image/png');
		}
	});

	test('carries the iOS and theme metadata in the raw HTML', async ({ page, request }) => {
		// `app.html` is what iOS reads before JS runs, so assert on the document
		// as written, not on the hydrated DOM.
		const response = await request.get('/');
		const html = await response.text();

		expect(html).toContain('rel="apple-touch-icon"');
		expect(html).toContain('/apple-touch-icon-180x180.png');
		expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
		expect(html).toContain('name="theme-color" content="#171717"');

		// And the browser resolves them on the live page. `toHaveAttribute` reads
		// the resolved absolute URL, which is the same file.
		await page.goto('/');
		await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
			'href',
			/apple-touch-icon-180x180\.png$/
		);
		const appleIcon = await page.request.get('/apple-touch-icon-180x180.png');
		expect(appleIcon.status()).toBe(200);
	});
});

test.describe('service worker', () => {
	test('registers and activates from the built app', async ({ page }) => {
		await page.goto('/');
		await hydration(page);

		const worker = await serviceWorkerActive(page);
		expect(worker.state).toBe('activated');
		expect(worker.scriptURL).toContain('/sw.js');
		expect(worker.scope).toBe(`${new URL(page.url()).origin}/`);
	});

	test('precaches the app shell, including the SPA fallback document', async ({ page }) => {
		await page.goto('/');
		await hydration(page);
		await serviceWorkerActive(page);

		const cached = await page.evaluate(async () => {
			const names = await caches.keys();
			const urls: string[] = [];
			for (const name of names) {
				const cache = await caches.open(name);
				urls.push(...(await cache.keys()).map((request) => new URL(request.url).pathname));
			}
			return urls;
		});

		expect(cached).toContain('/index.html');
		expect(cached.some((url) => url.startsWith('/_app/immutable/'))).toBe(true);
	});
});
