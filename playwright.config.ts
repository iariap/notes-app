import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4173);
const BASE_URL = `http://localhost:${PORT}`;

/**
 * The browser × viewport matrix from epic #1 / issue #11.
 *
 * Three viewports are first-class in the product spec of #1 — phone, tablet and
 * desktop — and the non-functional section names Chrome, Firefox and Safari.
 * WebKit is the only Safari engine Playwright drives, so "Safari" below means
 * WebKit; Edge is Chromium, so the Chromium projects cover it.
 *
 * ## Why `--project` and not an env flag
 *
 * The default scripts list the three Chromium projects explicitly
 * (`pnpm test:e2e`) and the full matrix is simply "no `--project`" flag
 * (`pnpm test:e2e:full`). Every project therefore stays individually selectable
 * — `pnpm exec playwright test --project=desktop-webkit` works — which an
 * env-var switch that *removes* projects from the config would break.
 *
 * ## Naming
 *
 * `desktop`, `tablet` and `mobile` keep their pre-#11 names on purpose: the
 * per-feature specs (#6–#10) branch on those names to assert the width-specific
 * behaviour, and renaming them would have meant editing twenty assertions to
 * say the same thing. The projects added here are suffixed with the engine:
 * `desktop-firefox`, `desktop-webkit`, `mobile-webkit`.
 */

/** Desktop: the two-pane layout, side-by-side editor + preview (`≥ xl`). */
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
/** Tablet: two panes, editor/preview behind tabs (the `md` breakpoint). */
const TABLET_VIEWPORT = { width: 768, height: 1024 };
/** Phone: one pane, editor/preview behind tabs. */
const MOBILE_VIEWPORT = { width: 375, height: 667 };

/**
 * `devices['Pixel 7']` and `devices['iPhone 14']` carry the honest mobile
 * signature (touch, `isMobile`, device pixel ratio, real UA string) but their
 * stock viewports are 412×915 and 390×844. The requirement is 375×667, so the
 * viewport is overridden while everything else about the device is kept: this
 * is "a Pixel 7-sized phone", not a desktop browser narrowed to 375 px.
 */
const pixel7 = { ...devices['Pixel 7'], viewport: MOBILE_VIEWPORT };
const iphone14 = { ...devices['iPhone 14'], viewport: MOBILE_VIEWPORT };

/**
 * Specs whose *assertions* are about Chromium's own delivery of a signal rather
 * than about the app: they simulate a hidden tab with `defineProperty`, drive
 * `page.clock`, or rewrite a build artifact on disk. Running them in every
 * engine would not add coverage of the app — it would add a second opinion
 * about the browser emulation layer — so the extra engines run the product
 * specs (`acceptance/` + the feature suites) and these stay Chromium-only.
 *
 * This is a scope decision, not a relaxation: every assertion in these files
 * still runs, unchanged, in the `desktop` project on every PR.
 */
const BROWSER_EMULATION_SPECS = [
	// Mutates `build/sw.js` and runs serial: one project owns it (see the spec).
	'pwa-update-prompt.spec.ts',
	// Uses `page.clock` and a real 1,000-note benchmark: the numbers it prints
	// are engine-specific and already reported by the `desktop` project.
	'notes-list-perf.spec.ts'
];

export default defineConfig({
	testDir: './tests/e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
	use: {
		baseURL: BASE_URL,
		trace: 'on-first-retry'
	},
	projects: [
		{
			name: 'desktop',
			use: { ...devices['Desktop Chrome'], viewport: DESKTOP_VIEWPORT }
		},
		{
			name: 'tablet',
			use: { ...devices['Desktop Chrome'], viewport: TABLET_VIEWPORT }
		},
		{
			name: 'mobile',
			use: { ...pixel7 }
		},
		{
			// Desktop Firefox: epic #1's "latest 2 versions of Firefox".
			name: 'desktop-firefox',
			use: { ...devices['Desktop Firefox'], viewport: DESKTOP_VIEWPORT },
			testIgnore: BROWSER_EMULATION_SPECS
		},
		{
			// Desktop WebKit: the Safari engine at the two-pane layout.
			name: 'desktop-webkit',
			use: { ...devices['Desktop Safari'], viewport: DESKTOP_VIEWPORT },
			testIgnore: BROWSER_EMULATION_SPECS
		},
		{
			// Mobile WebKit: iOS Safari, the single-pane layout.
			name: 'mobile-webkit',
			use: { ...iphone14 },
			testIgnore: BROWSER_EMULATION_SPECS
		}
	],
	webServer: {
		command: `pnpm build && pnpm preview --port ${PORT}`,
		url: BASE_URL,
		// `E2E_PORT` exists so parallel worktrees do not fight over one port: two
		// agents running the suite reused each other's preview server and tested
		// the wrong build. With a fixed port, reuse only when explicitly allowed.
		reuseExistingServer: !process.env.CI && process.env.E2E_PORT === undefined,
		timeout: 180_000
	}
});
