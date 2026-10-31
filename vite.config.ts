import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vitest/config';

const WEB_MANIFEST_FILE = 'manifest.webmanifest';

/**
 * The web app manifest, in one place: `@vite-pwa/sveltekit` writes it into the
 * build, and `serveManifestInDev` answers the same URL during `pnpm dev` so the
 * `<link rel="manifest">` in `app.html` never points at a 404.
 *
 * Colours are the shadcn theme in light mode (`--background` and `--primary`),
 * so the splash screen and window chrome match the app and the icon.
 */
const webManifest = {
	id: '/',
	name: 'Notes',
	short_name: 'Notes',
	description: 'A local-first notes app that runs entirely in your browser.',
	start_url: '/',
	scope: '/',
	display: 'standalone' as const,
	theme_color: '#171717',
	background_color: '#ffffff',
	lang: 'en',
	icons: [
		{ src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' as const },
		{ src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' as const },
		{
			src: '/maskable-icon-512x512.png',
			sizes: '512x512',
			type: 'image/png',
			purpose: 'maskable' as const
		}
	]
};

/**
 * Serves the manifest during `pnpm dev`. Without it the dev server answers the
 * manifest URL with 404, because the plugin only emits the file on build. The
 * service worker stays off in dev (see `devOptions` below) — this is just the
 * static JSON.
 */
function serveManifestInDev(): Plugin {
	return {
		name: 'notes-app:manifest-in-dev',
		apply: 'serve',
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				const { pathname } = new URL(request.url ?? '/', 'http://localhost');
				if (pathname !== `/${WEB_MANIFEST_FILE}`) return next();
				response.setHeader('content-type', 'application/manifest+json; charset=utf-8');
				response.end(`${JSON.stringify(webManifest, null, 2)}\n`);
			});
		}
	};
}

export default defineConfig({
	plugins: [
		tailwindcss(),
		serveManifestInDev(),
		sveltekit(),
		SvelteKitPWA({
			// A waiting service worker is announced in the UI with a "Reload"
			// action (see `src/lib/pwa/updates.ts`); nothing swaps the cache under
			// the user mid-edit.
			registerType: 'prompt',
			// Registration happens from our own module (`src/lib/pwa/updates.ts`),
			// not from an injected script tag, so the prompt is ours to control.
			injectRegister: false,
			// No service worker in `pnpm dev`: a stale cache while developing is
			// the classic way to debug a build that no longer exists. It is built
			// and used by `pnpm build && pnpm preview` (and by Playwright, which
			// serves that build).
			devOptions: { enabled: false },
			kit: {
				// The static adapter's fallback: `/notes/<id>` is served by this
				// shell, which is what makes deep links work with no network.
				adapterFallback: 'index.html',
				spa: true
			},
			manifest: webManifest,
			workbox: {
				// Any navigation — including `/notes/<id>` — is answered with the
				// precached app shell, so deep links resolve offline.
				navigateFallback: '/index.html',
				// The built app shell: JS/CSS chunks, the fonts the layout imports,
				// the manifest and every generated icon. Paths are relative to
				// `.svelte-kit/output`, where the static adapter has not yet copied
				// anything; the integration's `manifestTransforms` strips `client/`.
				globPatterns: ['client/**/*.{js,css,html,ico,png,svg,webp,woff2,webmanifest}'],
				globIgnores: ['server/**'],
				// An empty object means "rewrite no URL prefix". It is set because
				// the SvelteKit integration otherwise appends `prerendered/**` to
				// `globPatterns`, and this app prerenders nothing (`prerender =
				// false`): that pattern always matches zero files and makes every
				// build print a Workbox "glob doesn't match any files" warning.
				modifyURLPrefix: {}
			}
		})
	],
	// Svelte 5 components must resolve to their browser build under jsdom (Vitest).
	resolve: { conditions: ['browser'] },
	test: {
		include: ['tests/unit/**/*.{test,spec}.{js,ts}'],
		exclude: ['tests/e2e/**', 'node_modules/**', '.svelte-kit/**', 'build/**'],
		environment: 'jsdom',
		setupFiles: ['./tests/setup/vitest-setup.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text'],
			// Coverage is on by default so `pnpm test -- --coverage` (the command in
			// the issue, where pnpm forwards `--coverage` past the `--`) actually
			// measures it instead of silently running without it.
			enabled: true,
			// Only application code is measured: test helpers and generated shadcn
			// components are not ours to cover, and including them hides real gaps.
			include: ['src/lib/notes/**', 'src/lib/pwa/**'],
			exclude: ['src/lib/notes/**/*.d.ts', 'src/lib/pwa/**/*.d.ts']
		}
	}
});
