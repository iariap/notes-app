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
