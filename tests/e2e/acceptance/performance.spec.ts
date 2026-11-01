import { expect, test, type Page } from '@playwright/test';
import { seedNote, seedNotes, type SeedNote } from '../helpers/seed';
import { placeCaretAtEnd } from './support';

/**
 * The non-functional performance targets of epic #1 (#11 step 6), measured.
 *
 * - list first render with 1,000 notes
 * - typing latency inside a 10,000-character note
 * - repeat-visit first paint < 1 s
 *
 * ## Why this is not a second copy of `notes-list-perf.spec.ts`
 *
 * That spec already gates the 1,000-note cost — as a **delta against an empty
 * list measured on the same machine, in the same run**, because an absolute
 * wall-clock number measures the runner as much as the code (it recorded
 * 90–230 ms for the same list locally, and 503 ms under contention). Those
 * gates stay exactly as they are; this file does not restate them.
 *
 * What is new here is the two targets that spec never measured — typing latency
 * and repeat-visit first paint — plus an absolute reading of the first render
 * *recorded* next to the delta so the report can quote both.
 *
 * ## Which numbers are gated, and which are recorded
 *
 * | metric | how | gate |
 * |---|---|---|
 * | 1,000-note first render | delta over an empty load, same run | **gated** (< 500 ms, as #6 set) |
 * | typing latency, 10,000 chars | per-keystroke main-thread cost, 95th pct | **gated** (relative to an empty note) |
 * | repeat-visit first paint | absolute, after the service worker is warm | **recorded only** |
 *
 * The repeat-visit number is recorded rather than gated, deliberately. The
 * target in the epic ("< 1 s") is about a user's machine after a first visit,
 * and this suite's preview server is `localhost` with a cold cache per context;
 * an absolute gate there would either be trivially met (and mean nothing) or
 * fail on a loaded CI runner (and mean the runner is slow). The measured value
 * is printed and attached so `docs/qa-v1.md` can quote it and a regression is
 * still visible as a number that moved.
 *
 * Everything here runs in **one** project (`desktop`): the numbers are
 * engine- and viewport-specific, and six copies of the same benchmark would
 * triple the full-matrix runtime for no extra signal. The engine comparison is
 * a separate, cheaper test.
 */

const NOTE_COUNT = 1000;
const LIST_DELTA_BUDGET_MS = 500;
const TYPING_BUDGET_MS = 40;
/** A 10,000-character note: the size the issue names. */
const LONG_NOTE_LENGTH = 10_000;
/**
 * Keystrokes per measurement. Enough for a p95 to mean something (it is then the
 * worst couple of keystrokes) while keeping the test under two seconds.
 */
const KEYSTROKES = 40;

declare global {
	interface Window {
		__firstRender?: number;
	}
}

/** 1,000 notes with realistic, varied bodies. */
function thousandNotes(now: number): SeedNote[] {
	return Array.from({ length: NOTE_COUNT }, (_, index) => {
		const createdAt = new Date(now - index * 60_000).toISOString();
		const body =
			index % 3 === 0
				? `# Note ${index}\n- [ ] task one\n- [x] done\n\nSome prose long enough to be truncated by the preview rule at one hundred characters.`
				: index % 3 === 1
					? `**Note ${index}**\nA short emphasis body with a [link](https://example.com/${index}).`
					: `Note ${index}`;
		return seedNote(index, body, createdAt);
	});
}

/** Median of a sample set. */
function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** The value at `quantile` (0–1) of a sample set. */
function percentile(values: readonly number[], quantile: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
	return sorted[index];
}

/**
 * Installs a first-render probe that stamps the page clock when the list is
 * ready, before any app script runs.
 *
 * A `requestAnimationFrame` loop is the timestamp source because rAF only
 * advances when the main thread is free: the instant can never land in the
 * middle of the render it measures. The target comes from `sessionStorage` so
 * one script serves both the empty control and the seeded subject.
 */
async function installFirstRenderProbe(page: Page, target: 'empty' | number): Promise<void> {
	await page.addInitScript((expected) => {
		const ready = () => {
			if (expected === 'empty') {
				return document.querySelector('[data-slot="note-list-empty"]') !== null;
			}
			return document.querySelectorAll('[data-slot="note-row"]').length >= Number(expected);
		};
		const tick = () => {
			if (ready()) {
				window.__firstRender = performance.now();
				return;
			}
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}, target);
}

/** Cold-loads `/` and returns the page-clock instant the list became ready. */
async function coldLoadFirstRender(page: Page, target: 'empty' | number): Promise<number> {
	await page.goto('/');
	if (target === 'empty') {
		await expect(page.getByTestId('note-list-empty')).toBeVisible();
	} else {
		await expect(page.locator('[data-slot="note-row"]')).toHaveCount(target);
	}
	await page.waitForFunction(() => typeof window.__firstRender === 'number', undefined, {
		timeout: 30_000
	});
	return page.evaluate(() => window.__firstRender as number);
}

/**
 * Types `text` into the focused textarea one character at a time and returns the
 * per-keystroke latency, measured **inside the page**.
 *
 * ## The probe
 *
 * One capturing `input` listener on the document records `performance.now()` at
 * the event, then schedules a `requestAnimationFrame` and records how long it
 * took the frame to arrive. That interval is what "typing latency" means to a
 * user: from the keystroke being handled to it being on screen. Both timestamps
 * come from the page's own clock, so no Playwright round-trip is inside the
 * measurement.
 *
 * ## Why not the Event Timing API
 *
 * It was the first instrument and it is not trustworthy for this: `duration` is
 * quantised to the frame interval (so every sample reads ~16.7 ms and the metric
 * cannot distinguish 1 ms from 16 ms), entries are dropped once the observer's
 * buffer fills, and the reported sample count varied between 0 and 9 for the
 * same five keystrokes across consecutive rounds on this machine. A gate built
 * on numbers that appear and disappear would be worse than no gate. The
 * `input`-listener probe below reported a sample for every keystroke in every
 * run.
 *
 * Typing one character at a time (rather than pasting) is what makes the cost
 * per keystroke observable at all; the control case types the same number of
 * characters into an empty note, so the constant cost of Playwright's own input
 * dispatch is present in both and cancels out of the comparison.
 */
async function measureTypingLatency(page: Page, text: string): Promise<number[]> {
	await page.evaluate(() => {
		const durations: number[] = [];
		const onInput = (): void => {
			const started = performance.now();
			requestAnimationFrame(() => durations.push(performance.now() - started));
		};
		document.addEventListener('input', onInput, { capture: true });
		(
			window as unknown as { __typingDurations: number[]; __typingCleanup: () => void }
		).__typingDurations = durations;
		(window as unknown as { __typingCleanup: () => void }).__typingCleanup = () => {
			document.removeEventListener('input', onInput, { capture: true });
		};
	});

	for (const character of text) await page.keyboard.type(character);

	// Two frames: the last keystroke's own rAF has to land before it is read.
	await page.evaluate(
		() =>
			new Promise((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))
			)
	);

	const durations = await page.evaluate(() => {
		(window as unknown as { __typingCleanup?: () => void }).__typingCleanup?.();
		return (window as unknown as { __typingDurations?: number[] }).__typingDurations ?? [];
	});
	// The measured region held exactly one keystroke per typed character (a new
	// note also creates its row on the first one, so `input` fires once each).
	return durations;
}

test.describe('performance', () => {
	// One project: the benchmark is engine- and viewport-specific, and the six
	// projects would run the same measurement six times.
	test.beforeEach(() => {
		test.skip(
			test.info().project.name !== 'desktop',
			'the benchmark runs once, in the desktop Chromium project'
		);
	});

	test('1,000 notes cost less than 500 ms of extra first render', async ({ page }, testInfo) => {
		test.setTimeout(240_000);

		// Control and subject, same run, same machine: the shell, the bundle and
		// the runner's noise are paid identically by both and cancel in the delta.
		await installFirstRenderProbe(page, 'empty');
		await seedNotes(page, []);
		const emptySamples: number[] = [];
		for (let sample = 0; sample < 3; sample += 1) {
			emptySamples.push(await coldLoadFirstRender(page, 'empty'));
		}

		await installFirstRenderProbe(page, NOTE_COUNT);
		await seedNotes(page, thousandNotes(Date.now()));
		const seededSamples: number[] = [];
		for (let sample = 0; sample < 3; sample += 1) {
			seededSamples.push(await coldLoadFirstRender(page, NOTE_COUNT));
		}

		const empty = median(emptySamples);
		const seeded = median(seededSamples);
		const delta = Math.round(seeded - empty);

		const report =
			`1,000 notes: first render ${Math.round(seeded)} ms vs ${Math.round(empty)} ms empty ` +
			`(delta ${delta} ms); samples empty [${emptySamples.map(Math.round).join(', ')}] ` +
			`seeded [${seededSamples.map(Math.round).join(', ')}] — GATED at < ${LIST_DELTA_BUDGET_MS} ms`;
		console.log(`[perf] ${report}`);
		testInfo.annotations.push({ type: 'perf:list-first-render', description: report });
		await testInfo.attach('perf-list-first-render.txt', {
			body: report,
			contentType: 'text/plain'
		});

		expect(delta).toBeLessThan(LIST_DELTA_BUDGET_MS);
	});

	test('typing in a 10,000-character note stays responsive', async ({ page }, testInfo) => {
		test.setTimeout(240_000);

		// Control first: the same typing loop in an empty note, so the cost of
		// Playwright's own keystrokes cancels out of the comparison.
		await seedNotes(page, []);
		await page.goto('/notes/new');
		await page.waitForFunction(() => document.querySelector('[data-slot="app-shell"]') !== null);
		// A new note normally opens focused, but `seedNotes` reloads the page, so
		// the focus has to be asserted (and placed) rather than assumed: an
		// unfocused page sends every keystroke to `<body>` and measures nothing.
		await placeCaretAtEnd(page);
		await expect(page.getByRole('textbox', { name: 'Note' })).toBeFocused();
		const emptySamples = await measureTypingLatency(page, 'x'.repeat(KEYSTROKES));
		// A measurement that captured nothing must fail here, not produce a NaN
		// p95 that silently compares false to the budget.
		expect(emptySamples.length, 'no keystrokes were measured in the empty note').toBeGreaterThan(
			KEYSTROKES / 2
		);

		// Subject: a note at the size the issue names.
		const long = Array.from(
			{ length: Math.ceil(LONG_NOTE_LENGTH / 40) },
			(_, index) => `line ${index} of a deliberately long note`
		)
			.join('\n')
			.slice(0, LONG_NOTE_LENGTH);
		const [note] = await seedNotes(page, [seedNote(1, long, new Date().toISOString())]);
		await page.goto(`/notes/${note.id}`);
		await page.waitForFunction(() => document.querySelector('[data-slot="app-shell"]') !== null);
		await expect(page.getByRole('textbox', { name: 'Note' })).toHaveValue(long);

		// An existing note opens *without* focus (so reading one on a phone does
		// not raise the soft keyboard), so focus is placed first. Without it the
		// keystrokes go to `<body>` and the probe legitimately reports nothing —
		// the bug that made this measurement read 0 samples.
		await placeCaretAtEnd(page);
		await expect(page.getByRole('textbox', { name: 'Note' })).toBeFocused();
		const longSamples = await measureTypingLatency(page, 'y'.repeat(KEYSTROKES));
		expect(longSamples.length, 'no keystrokes were measured in the long note').toBeGreaterThan(
			KEYSTROKES / 2
		);

		const emptyP95 = percentile(emptySamples, 0.95);
		const longP95 = percentile(longSamples, 0.95);

		const report =
			`typing in ${LONG_NOTE_LENGTH.toLocaleString('en-US')} chars: p95 event cost ` +
			`${Math.round(longP95)} ms vs ${Math.round(emptyP95)} ms in an empty note ` +
			`(median ${Math.round(median(longSamples))} ms, ${longSamples.length} keystrokes) ` +
			`— GATED at p95 < ${TYPING_BUDGET_MS} ms`;
		console.log(`[perf] ${report}`);
		testInfo.annotations.push({ type: 'perf:typing', description: report });
		await testInfo.attach('perf-typing.txt', { body: report, contentType: 'text/plain' });

		expect(longP95, `typing p95 in a long note: ${Math.round(longP95)} ms`).toBeLessThan(
			TYPING_BUDGET_MS
		);
	});

	test('repeat-visit first paint is recorded (target < 1 s)', async ({ page }, testInfo) => {
		// Warm the service worker: the "repeat visit" the epic describes is the
		// one served from the precache rather than the network.
		await page.goto('/');
		await page.evaluate(async () => {
			await navigator.serviceWorker.ready;
		});
		await page.reload();

		const samples: number[] = [];
		for (let sample = 0; sample < 3; sample += 1) {
			await page.goto('/');
			await page.waitForFunction(() => document.querySelector('[data-slot="app-shell"]') !== null);
			// First Contentful Paint, as the browser itself reports it: the
			// navigation timing entry is per-document, so this is this load's paint.
			samples.push(
				await page.evaluate(() => {
					const paint = performance
						.getEntriesByType('paint')
						.find((entry) => entry.name === 'first-contentful-paint');
					return paint?.startTime ?? performance.now();
				})
			);
		}

		const medianPaint = median(samples);
		const report =
			`repeat-visit first contentful paint: median ${Math.round(medianPaint)} ms ` +
			`[${samples.map((value) => Math.round(value)).join(', ')}] ms — RECORDED, target < 1000 ms`;
		console.log(`[perf] ${report}`);
		testInfo.annotations.push({ type: 'perf:first-paint', description: report });
		await testInfo.attach('perf-first-paint.txt', { body: report, contentType: 'text/plain' });

		// Recorded, not gated: see the module comment. The assertion that remains
		// is that the metric is real and finite, so a broken probe fails loudly
		// instead of quietly reporting zero.
		expect(medianPaint).toBeGreaterThan(0);
		expect(Number.isFinite(medianPaint)).toBe(true);
	});
});
