import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/svelte';
import { afterEach } from 'vitest';

// Vitest runs without `globals`, so Testing Library's automatic cleanup is off;
// without this, renders leak between tests and role queries match duplicates.
afterEach(() => {
	cleanup();
});

// jsdom does not implement ResizeObserver, which bits-ui primitives (ScrollArea
// among them) construct on mount. A no-op implementation keeps component tests
// focused on markup and behaviour; real layout is verified in Playwright.
if (!globalThis.ResizeObserver) {
	class ResizeObserverStub implements ResizeObserver {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	}

	globalThis.ResizeObserver = ResizeObserverStub;
}

// jsdom does not implement `matchMedia` either, and `svelte-sonner`'s toaster
// asks for the colour-scheme preference on mount. The stub answers "no match"
// for every query, so a component that only distinguishes light from dark
// renders its light branch — which is what the tests assert on.
if (!globalThis.matchMedia) {
	globalThis.matchMedia = ((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addEventListener: () => {},
		removeEventListener: () => {},
		addListener: () => {},
		removeListener: () => {},
		dispatchEvent: () => false
	})) as unknown as typeof globalThis.matchMedia;
}
