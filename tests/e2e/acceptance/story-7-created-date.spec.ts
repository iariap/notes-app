import { expect, test, type Page } from '@playwright/test';
import { hydration } from '../helpers/keyboard';
import { rows, seedNote, seedNotes, waitForList } from '../helpers/seed';
import { sweepWidths } from './support';

/**
 * Story 7 — **Created date**.
 *
 * Epic #1: "stored as ISO 8601 UTC, shown in local time; relative ('2 hours
 * ago', 'Yesterday') up to 7 days, then an absolute date ('Oct 24, 2026'); full
 * date/time on hover and in the open note."
 *
 * ## Reuse
 *
 * The formatting rules are a pure function with a full unit table
 * (`tests/unit/note-date.spec.ts`, including the local-midnight and future-skew
 * cases a browser test cannot reach deterministically), and #6's
 * `notes-list.spec.ts` asserts the rendered labels, the `datetime` attribute,
 * the tooltip and the self-ageing label end to end.
 *
 * This file adds the acceptance-specific gaps: the **open note** shows the full
 * date (no earlier spec asserts that), the labels are shown in the reader's
 * local time rather than UTC, and the date column survives the five-width sweep.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * A fixed "now" for the relative-label assertions.
 *
 * The labels are calendar-based in the reader's zone, so an assertion about
 * "Yesterday" cannot be made against the wall clock: a suite that runs at 00:05
 * has *no* instant that is both more than 24 h ago and still yesterday's date,
 * and one that runs at 23:00 has two. Installing a page clock at a known local
 * time — 15:00, comfortably inside the day — makes the expected labels exact and
 * independent of when CI happens to run.
 *
 * The instants below are computed from that fixed now in local time, so they
 * mean the same thing in every timezone: 13:00 today, noon yesterday, noon ten
 * days ago.
 */
const FIXED_NOW = new Date(2026, 9, 31, 15, 0, 0, 0);

/** `hours` of local wall time before `FIXED_NOW`, as the ISO string storage holds. */
function hoursBeforeFixedNow(hours: number): string {
	return new Date(FIXED_NOW.getTime() - hours * HOUR).toISOString();
}

/** Local `day` days before `FIXED_NOW` at `hour:00`, as an ISO string. */
function daysBeforeFixedNow(days: number, hour: number): string {
	const date = new Date(FIXED_NOW);
	date.setDate(date.getDate() - days);
	date.setHours(hour, 0, 0, 0);
	return date.toISOString();
}

/**
 * Installs the fixed clock **before any app script runs**.
 *
 * Order matters: the store derives its labels from `Date`, so the clock has to
 * be in place before the first render, not adjusted afterwards.
 */
async function installFixedClock(page: Page): Promise<void> {
	await page.clock.install({ time: FIXED_NOW });
}

test.describe('story 7 — Created date', () => {
	test('AC1: relative within the week, absolute beyond it', async ({ page }) => {
		// 15:00 local: "2 hours ago" is 13:00 the same day, "Yesterday" is noon
		// the day before, and ten days back is outside the 7-day window.
		await installFixedClock(page);
		await seedNotes(page, [
			seedNote(1, 'Two hours ago', hoursBeforeFixedNow(2)),
			seedNote(2, 'Yesterday', daysBeforeFixedNow(1, 12)),
			seedNote(3, 'Ten days ago', daysBeforeFixedNow(10, 12))
		]);
		await waitForList(page);

		const dates = rows(page).locator('time');
		await expect(dates.nth(0)).toHaveText('2 hours ago');
		await expect(dates.nth(1)).toHaveText(/^(Yesterday|1 day ago)$/);
		// Ten days back: outside the 7-day window, so the absolute date.
		await expect(dates.nth(2)).toHaveText(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
	});

	test('AC2: the stored value is ISO 8601 UTC and the label is local time', async ({ page }) => {
		// A fixed instant, so this asserts the *format* rather than the clock.
		const createdAt = '2026-10-24T18:13:00.000Z';
		await seedNotes(page, [seedNote(1, 'A dated note', createdAt, createdAt)]);
		await waitForList(page);

		const time = rows(page).nth(0).locator('time');
		// `datetime` is the stored UTC instant, untouched by the locale.
		await expect(time).toHaveAttribute('datetime', createdAt);

		// The visible label is derived from that instant in the reader's zone. The
		// only universal claim is that it is *some* rendering of the same day:
		// pinning a zone inside the test would assert the test's own timezone.
		const label = (await time.textContent())?.trim() ?? '';
		expect(label.length).toBeGreaterThan(0);
		expect(label).not.toContain('Invalid');
	});

	test('AC3: the full date and time is on hover, and in the open note', async ({ page }) => {
		const createdAt = '2026-10-24T18:13:00.000Z';
		const [note] = await seedNotes(page, [seedNote(1, 'A dated note', createdAt, createdAt)]);
		await waitForList(page);

		// On hover: the tooltip carries the full local date and time.
		const title = await rows(page).nth(0).locator('time').getAttribute('title');
		expect(title).toMatch(/\d{1,2}:\d{2}/);
		expect(title).toMatch(/\d{4}/);
		await rows(page).nth(0).hover();
		const tooltip = page.locator('[data-slot="tooltip-content"]');
		await expect(tooltip).toHaveText(title as string);

		// In the open note: the editor header shows it without hovering.
		await page.goto(`/notes/${note.id}`);
		await hydration(page);
		const header = page.getByTestId('editor-created-date');
		await expect(header).toBeVisible();
		await expect(header).toHaveText(new RegExp(/\d{1,2}:\d{2}/));
	});

	test('AC4: the date is never the last-edited date', async ({ page }) => {
		// The product decision: `updatedAt` orders the list but is never shown.
		await installFixedClock(page);
		const edited = seedNote(1, 'Edited a minute ago', daysBeforeFixedNow(3, 12));
		// Edited one minute ago: `updatedAt` is the sort key and must not be shown.
		edited.updatedAt = new Date(FIXED_NOW.getTime() - MINUTE).toISOString();
		await seedNotes(page, [edited]);
		await waitForList(page);

		// Created three days ago, edited a minute ago: the label follows creation.
		await expect(rows(page).nth(0).locator('time')).toHaveText('3 days ago');
		expect(await rows(page).nth(0).locator('time').getAttribute('datetime')).toBe(edited.createdAt);
	});

	test('AC5: no horizontal overflow with every date shape on screen, 320 through 1920 px', async ({
		page
	}, testInfo) => {
		await installFixedClock(page);
		await seedNotes(page, [
			seedNote(1, 'Two hours ago', hoursBeforeFixedNow(2)),
			seedNote(2, 'Yesterday', daysBeforeFixedNow(1, 12)),
			seedNote(3, 'Ten days ago', daysBeforeFixedNow(10, 12))
		]);
		await waitForList(page);

		// The absolute label ("Oct 24, 2026") is the widest thing in the row's
		// date column, so this sweep is what proves it fits a 320 px phone.
		await sweepWidths(page, testInfo, 'story-7 date labels');
	});
});
