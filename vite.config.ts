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
		setupFiles: ['./tests/setup/vitest-setup.ts']
	}
});
