import { expect, test, type Page } from '@playwright/test';
import {
	coldLoadToReady,
	describeRender,
	describeSamples,
	expectRenderWithinBudget,
	installListReadyProbe,
	measureRender,
	median
} from './helpers/list-perf';
import { withPerfBenchmarkLock } from './helpers/perf-lock';
import { seedNote, seedNotes } from './helpers/seed';

/**
 * Issue #6, step 4: the list must stay responsive with 1,000 notes.
 *
 * ## What is gated, and why it is a ratio
 *
 * The claim under test is relative: "1,000 notes do not cost more than the
 * list is allowed to cost". An absolute wall-clock budget measures the machine
 * as much as the code, so on a shared CI runner it is a permanent source of
 * red: the same list measured 90–230 ms per cold load locally while a raw load
 * under contention hit 503 ms.
 *
 * The first two versions of this gate used a **difference** against a control
 * measured on the same machine, in the same run, on the same page:
 * `seeded − empty`. That cancels the constant cost (bundle download, parse,
 * hydration, shell) but it does **not** cancel the variable one: rendering 1,000
 * rows is CPU work, so a slower machine grows the difference while the part that
 * cancels stays put. Measured across four machine speeds, the difference gate
 * quietly permitted only `1 + 500/empty` — a permitted ratio of 21.0 on a fast
 * machine and 3.96 under throttling — while the app's real ratio stayed near 4.9.
 * It was a floor on runner speed disguised as a test of the app.
 *
 * So the render gate is now the **ratio**: `seededMedian / emptyMedian` against
 * `RENDER_RATIO_BUDGET` (7.5). The property is a multiple — 1,000 rows cost about
 * 5x the empty load on any machine — and the ratio is stable where the difference
 * is not. See `tests/e2e/helpers/list-perf.ts` for the full measurement table.
 *
 * The absolute marginal is still printed, and still worth reading: it is how a
 * human notices the *runner* drifting. It is not asserted.
 *
 * - first render: **ratio** `seeded / empty`, gated at < 7.5x.
 * - scrolling: longest frame while scrolling 1,000 rows minus longest frame
 *   while scrolling an empty list through the identical loop. This one is still a
 *   difference, and correctly so: both sides run the same fixed 30-step loop and
 *   the measured frames are ~17 ms on every machine (18 ms empty → 17 ms seeded),
 *   so there is no machine-speed term to cancel.
 *
 * And each side of every measurement is the **median of several cold loads**
 * (9 empty, 5 seeded), so a single GC pause or a noisy neighbour cannot fail the
 * test while a genuine regression still moves the median. The per-sample values
 * are printed next to the medians, so a report can quote the spread rather than
 * one lucky number.
 *
 * Measured this way the test is meaningful under parallel workers: contention
 * inflates both the control and the subject, and the ratio absorbs it.
 *
 * ## The probe
 *
 * Both instants come from the page's own `performance.now()` clock, sampled by
 * a probe installed before any app script runs, so no Playwright round-trip is
 * inside the measurement. The probe is a `requestAnimationFrame` loop: rAF
 * advances only when the main thread is free, so the timestamp can never land
 * in the middle of the render it measures. Its target ("empty state" or "N
 * rows") is read from `sessionStorage` at document start, so one init script
 * serves every load with the right target instead of stacking scripts that
 * would race each other for the same global. Both sides tick the same shape of
 * check, so the probe's own cost is identical on each side of the ratio.
 *
 * ## Why there is no windowing
 *
 * 1,000 rows render within the budget and scroll without a frame over ~19 ms,
 * which is the issue's "smooth scrolling" bar. Windowing would add
 * scroll-position bookkeeping, break native find-in-page, and trade the list's
 * continuous tab order for a saving the measurements say is not needed.
 */

const NOTE_COUNT = 1000;

/** `1000` as a report reads it. */
const NOTE_COUNT_LABEL = NOTE_COUNT.toLocaleString('en-US');

/** Cold loads per condition. The median of these is what the gates read. */
const RENDER_SAMPLES = 5;
const SCROLL_SAMPLES = 3;

/**
 * Cold loads for the **empty** condition.
 *
 * Higher than the seeded side on purpose. The empty load is the cheap one
 * (~25 ms locally, ~136 ms on the slow CI runner), so it is also the side whose
 * sampling noise dominates the variance of the ratio — and since the ratio puts
 * it in the *denominator*, noise there moves the gated number more than the same
 * noise on the seeded side. Nine samples cut that variance roughly by half for
 * about 0.2 s of extra runtime; the seeded side already costs an order of
 * magnitude more per sample, so it stays at 5.
 */
const EMPTY_SAMPLES = 9;

/** Marginal cost of the longest scroll frame over the empty baseline. */
const SCROLL_FRAME_BUDGET_MS = 250;

/**
 * Benchmarking 1,000-note cold loads several times per test legitimately needs
 * more than the suite default; the gate is the measured delta, not the clock.
 */
const PERF_TEST_TIMEOUT_MS = 240_000;

/** 1,000 notes with varied, realistic bodies. */
function thousandNotes(now: number) {
	return Array.from({ length: NOTE_COUNT }, (_, index) => {
		const createdAt = new Date(now - index * 60_000).toISOString();
		const body =
			index % 3 === 0
				? `# Note ${index}\n- [ ] task one for ${index}\n- [x] done already\n\nSome prose that is long enough to be truncated by the preview rule at one hundred characters.`
				: index % 3 === 1
					? `**Note ${index}**\nA short emphasis body with a [link](https://example.com/${index}).`
					: `Note ${index}`;
		return seedNote(index, body, createdAt);
	});
}

/**
 * Scrolls the list viewport in steps and returns the longest frame the main
 * thread took. The scroll target is a hard-coded pane/scroll-area pair rather
 * than a shared selector on purpose: this measures the shipped markup.
 */
function longestScrollFrame(page: Page): Promise<number> {
	return page.evaluate(async () => {
		const viewport = document.querySelector<HTMLElement>(
			'[data-pane="list"] [data-slot="scroll-area-viewport"]'
		);
		if (!viewport) return Number.POSITIVE_INFINITY;

		const frames: number[] = [];
		let last = performance.now();
		for (let step = 0; step < 30; step += 1) {
			viewport.scrollTop += viewport.clientHeight;
			await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
			const now = performance.now();
			frames.push(now - last);
			last = now;
		}
		return Math.max(...frames);
	});
}

test.describe('1,000 notes', () => {
	test.skip(
		({ viewport }) => (viewport?.width ?? 0) < 768,
		'performance target is desktop Chromium'
	);

	test('1,000 notes render within the ratio budget', async ({ page }, testInfo) => {
		test.setTimeout(PERF_TEST_TIMEOUT_MS);

		// One of up to three concurrent copies of this benchmark (this file in
		// `desktop` and `tablet`, plus `acceptance/performance.spec.ts` in `desktop`).
		// They are mutually excluded by a cross-process lock: see
		// `tests/e2e/helpers/perf-lock.ts` for why `describe.configure` cannot do it.
		const emptySamples: number[] = [];
		const seededSamples: number[] = [];
		await withPerfBenchmarkLock(`notes-list-perf@${testInfo.project.name}`, async () => {
			await installListReadyProbe(page);

			// Control: the identical cold load with an empty list.
			await seedNotes(page, []);
			for (let sample = 0; sample < EMPTY_SAMPLES; sample += 1) {
				emptySamples.push(await coldLoadToReady(page, { kind: 'empty' }));
			}

			// Subject: the same load with 1,000 notes in storage.
			await seedNotes(page, thousandNotes(Date.now()));
			for (let sample = 0; sample < RENDER_SAMPLES; sample += 1) {
				seededSamples.push(await coldLoadToReady(page, { kind: 'rows', count: NOTE_COUNT }));
			}
		});

		const measurement = measureRender(emptySamples, seededSamples);

		const description = `${NOTE_COUNT_LABEL} notes: ${describeRender(
			measurement,
			`${EMPTY_SAMPLES} empty + ${RENDER_SAMPLES} seeded cold loads from document start`
		)} — ${describeSamples('empty', emptySamples)} → ${describeSamples('seeded', seededSamples)}`;
		testInfo.annotations.push({ type: 'perf:first-render', description });
		console.log(`[perf] ${description}`);

		expectRenderWithinBudget(measurement);
	});

	test('scrolling 1,000 notes does not block the main thread', async ({ page }, testInfo) => {
		test.setTimeout(PERF_TEST_TIMEOUT_MS);

		// Control: the same scroll loop against an empty list. The frame budget
		// itself is absolute, so it is measured on a loaded machine twice — once
		// with no rows and once with 1,000 — and only the difference is gated.
		await seedNotes(page, []);
		const emptyFrames: number[] = [];
		for (let sample = 0; sample < SCROLL_SAMPLES; sample += 1) {
			await page.goto('/');
			await expect(page.getByTestId('note-list-empty')).toBeVisible();
			emptyFrames.push(await longestScrollFrame(page));
		}

		await seedNotes(page, thousandNotes(Date.now()));
		const seededFrames: number[] = [];
		for (let sample = 0; sample < SCROLL_SAMPLES; sample += 1) {
			await page.goto('/');
			await expect(page.locator('[data-slot="note-row"]')).toHaveCount(NOTE_COUNT);
			seededFrames.push(await longestScrollFrame(page));
		}

		const empty = median(emptyFrames);
		const seeded = median(seededFrames);
		const marginal = Math.round(seeded - empty);

		const description =
			`longest frame while scrolling ${NOTE_COUNT_LABEL} notes costs ${marginal} ms over an empty ` +
			`list — ${describeSamples('empty', emptyFrames)} → ${describeSamples(
				'seeded',
				seededFrames
			)}, ${SCROLL_SAMPLES} passes each`;
		testInfo.annotations.push({ type: 'perf:scroll', description });
		console.log(`[perf] ${description}`);

		expect(marginal).toBeLessThan(SCROLL_FRAME_BUDGET_MS);
	});
});
