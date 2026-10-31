import { defineConfig } from '@vite-pwa/assets-generator/config';

/**
 * Icon generation for the PWA: `pnpm run generate:icons`.
 *
 * `static/icon.svg` is the only source of truth; the rasters the manifest and
 * the iOS meta tags reference are generated from it and committed, so `pnpm
 * build` never needs this script and never needs to run an install hook. Sizes
 * are the ones the issue asks for (192, 512, a 512 maskable) plus the 180 px
 * `apple-touch-icon` iOS uses for the Home Screen.
 *
 * The maskable and apple variants are flattened onto the same neutral as the
 * icon background: both are composited by the OS onto unknown wallpapers, and a
 * transparent icon reads as a hole there.
 */
export default defineConfig({
	images: ['static/icon.svg'],
	preset: {
		transparent: {
			sizes: [192, 512]
		},
		maskable: {
			sizes: [512],
			resizeOptions: { background: '#171717' }
		},
		apple: {
			sizes: [180],
			resizeOptions: { background: '#171717' }
		}
	},
	// The manifest lives in `vite.config.ts`, next to the Workbox config that
	// precaches those same icons; the CLI must not rewrite it behind our back.
	manifestIconsEntry: false
});
