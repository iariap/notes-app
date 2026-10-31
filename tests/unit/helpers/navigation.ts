import { vi } from 'vitest';

/**
 * The `$app/navigation` surface the editor touches, as a test double.
 *
 * `NoteEditor` registers a `beforeNavigate` interceptor and an awaited
 * `onNavigate` hook, and rewrites the URL with `replaceState`; none of that
 * exists outside a running SvelteKit router, and the real module throws when
 * imported without one. Tests that only need the behaviour can install this
 * instead, and drive the hooks by hand.
 *
 * Returned handles so a test can assert exactly what the editor did:
 * `fireBeforeNavigate()` runs the registered interceptor, `fireNavigate()`
 * awaits the registered `onNavigate` (the one SvelteKit waits for), and
 * `replaceState` records the shallow history updates.
 */
export interface NavigationHarness {
	/** Runs every registered `beforeNavigate` callback. */
	fireBeforeNavigate(): void;
	/** Awaits every registered `onNavigate` callback, as SvelteKit does. */
	fireNavigate(): Promise<void>;
	/** URLs passed to `replaceState`, in order. */
	replacements(): string[];
	/** `false` when no navigation hook is registered (e.g. no editor mounted). */
	hasHooks(): boolean;
}

const state = vi.hoisted(() => ({
	before: new Set<() => void>(),
	navigate: new Set<() => unknown>(),
	replacements: [] as string[]
}));

/** Module mock body; pass to `vi.mock('$app/navigation', navigationMock)`. */
export function navigationMock(): Record<string, unknown> {
	return {
		beforeNavigate: (callback: () => void) => {
			state.before.add(callback);
		},
		onNavigate: (callback: () => unknown) => {
			state.navigate.add(callback);
		},
		afterNavigate: () => {},
		replaceState: (url: string | URL) => {
			state.replacements.push(String(url));
		},
		goto: async (url: string | URL) => {
			state.replacements.push(`goto:${String(url)}`);
		}
	};
}

/** Resets the module-level record between tests. */
export function resetNavigationMock(): void {
	state.before.clear();
	state.navigate.clear();
	state.replacements.length = 0;
}

/** A handle over the callbacks the mounted component registered. */
export function navigationHarness(): NavigationHarness {
	return {
		fireBeforeNavigate() {
			for (const callback of [...state.before]) callback();
		},
		async fireNavigate() {
			for (const callback of [...state.navigate]) await callback();
		},
		replacements() {
			return [...state.replacements];
		},
		hasHooks() {
			return state.before.size > 0 || state.navigate.size > 0;
		}
	};
}
