import { expect, type Page } from '@playwright/test';

/**
 * The 1,000-note first-render probe, shared by the two specs that measure it.
 *
 * `tests/e2e/notes-list-perf.spec.ts` (#6, load-bearing and green) and
 * `tests/e2e/acceptance/performance.spec.ts` (#11) both measure this, and #11
 * shipped a second, *different* implementation of the probe with three defects.
 * One helper means they can never drift apart again: a change to how the metric
 * is taken is now a change in one place, and both specs get it.
 *
 * ## The probe
 *
 * Both instants come from the page's own `performance.now()` clock, stamped by a
 * probe installed **before any app script runs**, so no Playwright round-trip is
 * inside the measurement. A `requestAnimationFrame` loop is the timestamp source
 * because rAF only advances when the main thread is free: the instant can never
 * land in the middle of the render it measures.
 *
 * ## Why the target travels in `sessionStorage`, and why that is not optional
 *
 * `addInitScript` **accumulates**: every call adds another script that runs on
 * every subsequent navigation, for the life of the page. Registering a second
 * probe with a different target therefore does not replace the first — it leaves
 * both running. On a seeded load the `'empty'` probe can never become ready, so
 * it spins a `requestAnimationFrame` loop that re-queries the DOM on every frame
 * *during the render it is supposed to be measuring*, and writes its result into
 * the same global the real probe uses.
 *
 * That is not hypothetical: it is what #11's first version did (one
 * `installFirstRenderProbe(page, 'empty')` call and later a second with
 * `NOTE_COUNT`), and it is measurable — 24 extra `querySelector` calls per
 * measured seeded load, and a seeded median ~4 % above the single-probe number
 * under 8× CPU throttling (858 ms vs 823 ms).
 *
 * So the probe is installed **once** per page and reads its target from
 * `sessionStorage` at document start. `coldLoadToReady` hands the next load its
 * target before navigating, so one script serves every load with the right
 * target and no two probes ever race.
 */
export interface ListTarget {
	/** The empty state is what marks the load ready. */
	kind: 'empty';
}

export interface RowsTarget {
	/** The list has rendered at least this many rows. */
	kind: 'rows';
	count: number;
}

export type LoadTarget = ListTarget | RowsTarget;

/** Where the current load's target is handed to the init script. */
export const LIST_TARGET_KEY = 'perf:list-target';

declare global {
	interface Window {
		__listReady?: number;
	}
}

/**
 * Installs the page-clock probe on `page`. Call it **once** per page, before the
 * first measured load; calling it again would stack a second loop (see the
 * module comment).
 */
export async function installListReadyProbe(page: Page): Promise<void> {
	await page.addInitScript((key) => {
		const target = JSON.parse(sessionStorage.getItem(key) ?? '{"kind":"empty"}') as
			{ kind: 'empty' } | { kind: 'rows'; count: number };
		// A previous load's stamp must not be read as this load's: the caller
		// waits for a *number*, and a stale one would resolve instantly.
		window.__listReady = undefined;
		const tick = () => {
			const ready =
				target.kind === 'empty'
					? document.querySelector('[data-slot="note-list-empty"]') !== null
					: document.querySelectorAll('[data-slot="note-row"]').length >= target.count;
			if (ready) {
				window.__listReady = performance.now();
				return;
			}
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}, LIST_TARGET_KEY);
}

/**
 * Cold-loads `/` and returns the page-clock instant at which the list was ready,
 * after proving to Playwright that it really settled into the state the probe
 * waits for.
 */
export async function coldLoadToReady(page: Page, target: LoadTarget): Promise<number> {
	// Same origin as the app, so `sessionStorage` accepts the write; the value
	// survives the navigation the probe then measures.
	await page.evaluate(({ key, value }) => sessionStorage.setItem(key, value), {
		key: LIST_TARGET_KEY,
		value: JSON.stringify(target)
	});
	await page.goto('/');

	if (target.kind === 'empty') {
		await expect(page.getByTestId('note-list-empty')).toBeVisible();
	} else {
		await expect(page.locator('[data-slot="note-row"]')).toHaveCount(target.count);
	}

	await page.waitForFunction(() => typeof window.__listReady === 'number', undefined, {
		timeout: 30_000
	});
	return page.evaluate(() => window.__listReady as number);
}

/**
 * Median of a sample set (even counts average the two middle values).
 *
 * The median of several cold loads, not a single reading, is what makes a gate
 * here meaningful: one GC pause or one noisy neighbour moves a mean but not the
 * middle of a sample set.
 */
export function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** How a report reads a sample set: `label median N ms [a, b, c]`. */
export function describeSamples(label: string, samples: readonly number[]): string {
	return `${label} median ${Math.round(median(samples))} ms [${samples
		.map((value) => Math.round(value))
		.join(', ')}]`;
}
