import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
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
			include: ['src/lib/notes/**'],
			exclude: ['src/lib/notes/**/*.d.ts']
		}
	}
});
