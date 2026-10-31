import { describe, expect, it } from 'vitest';
import { JUST_NOW, RELATIVE_WINDOW_DAYS, formatCreatedDate, formatFullDate } from '$lib/notes/date';

/**
 * All expectations are built from **local** dates, so the suite asserts the
 * behaviour the user sees ("local time", epic #1) without depending on the
 * machine's time zone: a fixed `TZ` would make these pass only in CI.
 */
const LOCAL = 'en-US';
const second = 1000;
const minute = 60 * second;
const hour = 60 * minute;
const day = 24 * hour;

/** Local wall-clock instant → the ISO string the store would have stored. */
const localIso = (year: number, monthIndex: number, dayOfMonth: number, hours = 12, minutes = 0) =>
	new Date(year, monthIndex, dayOfMonth, hours, minutes, 0, 0).toISOString();

const NOW = new Date(2026, 9, 31, 13, 13, 0, 0);
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe('formatCreatedDate', () => {
	it('says "just now" under one minute', () => {
		expect(formatCreatedDate(ago(0), NOW, LOCAL)).toBe(JUST_NOW);
		expect(formatCreatedDate(ago(59 * second), NOW, LOCAL)).toBe(JUST_NOW);
	});

	it('says "just now" for a timestamp in the future (clock skew)', () => {
		expect(formatCreatedDate(new Date(NOW.getTime() + 5 * minute).toISOString(), NOW, LOCAL)).toBe(
			JUST_NOW
		);
	});

	it('uses minutes under an hour', () => {
		expect(formatCreatedDate(ago(minute), NOW, LOCAL)).toBe('1 minute ago');
		expect(formatCreatedDate(ago(5 * minute), NOW, LOCAL)).toBe('5 minutes ago');
		expect(formatCreatedDate(ago(59 * minute), NOW, LOCAL)).toBe('59 minutes ago');
	});

	it('uses hours under a day', () => {
		expect(formatCreatedDate(ago(hour), NOW, LOCAL)).toBe('1 hour ago');
		expect(formatCreatedDate(ago(2 * hour), NOW, LOCAL)).toBe('2 hours ago');
		expect(formatCreatedDate(ago(23 * hour), NOW, LOCAL)).toBe('23 hours ago');
	});

	it('says "Yesterday" for one calendar day', () => {
		expect(formatCreatedDate(ago(day), NOW, LOCAL)).toBe('Yesterday');
	});

	it('counts calendar days, not elapsed 24 h blocks', () => {
		// 26 h before 01:00 on Oct 31 is 23:00 on Oct 29: two calendar days back,
		// so "Yesterday" (what elapsed-only maths would say) would be wrong.
		const now = new Date(2026, 9, 31, 1, 0, 0, 0);
		expect(formatCreatedDate(new Date(2026, 9, 29, 23, 0).toISOString(), now, LOCAL)).toBe(
			'2 days ago'
		);
		// And a note from "yesterday evening" read the next morning is "Yesterday",
		// even though fewer than 24 h have passed.
		const morning = new Date(2026, 9, 31, 9, 0, 0, 0);
		expect(formatCreatedDate(new Date(2026, 9, 30, 22, 0).toISOString(), morning, LOCAL)).toBe(
			'11 hours ago'
		);
	});

	it('switches to the absolute date past the relative window', () => {
		const now = new Date(2026, 9, 31, 13, 0, 0, 0);
		expect(formatCreatedDate(new Date(2026, 9, 24, 22, 0).toISOString(), now, LOCAL)).toBe(
			'Oct 24, 2026'
		);
		// Six calendar days back is still relative.
		expect(formatCreatedDate(new Date(2026, 9, 25, 9, 0).toISOString(), now, LOCAL)).toBe(
			'6 days ago'
		);
	});

	it('uses days up to six calendar days, then the absolute date', () => {
		expect(formatCreatedDate(ago(3 * day), NOW, LOCAL)).toBe('3 days ago');
		expect(formatCreatedDate(ago(6 * day), NOW, LOCAL)).toBe('6 days ago');
		expect(formatCreatedDate(ago(RELATIVE_WINDOW_DAYS * day), NOW, LOCAL)).toBe('Oct 24, 2026');
	});

	it('formats older notes as an absolute local date', () => {
		expect(formatCreatedDate(localIso(2026, 9, 24), NOW, LOCAL)).toBe('Oct 24, 2026');
		expect(formatCreatedDate(localIso(2025, 0, 3), NOW, LOCAL)).toBe('Jan 3, 2025');
	});

	it('renders the local calendar date of a late-UTC instant', () => {
		// The absolute branch must use the reader's calendar day, not UTC's.
		const localLate = new Date(2026, 9, 10, 23, 30);
		const expected = new Intl.DateTimeFormat(LOCAL, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		}).format(localLate);

		expect(formatCreatedDate(localLate.toISOString(), NOW, LOCAL)).toBe(expected);
	});

	it('returns an empty string for an unparseable timestamp', () => {
		expect(formatCreatedDate('not a date', NOW, LOCAL)).toBe('');
		expect(formatCreatedDate('', NOW, LOCAL)).toBe('');
	});

	it('defaults to the current time and the runtime locale', () => {
		// Only the relative branch is asserted: the absolute form depends on TZ.
		expect(formatCreatedDate(new Date().toISOString())).toBe(JUST_NOW);
	});

	it('never mentions an updated timestamp: it only accepts createdAt', () => {
		// A guard on the contract: the signature is (iso, now, locale), so there is
		// no parameter through which `updatedAt` could reach the UI.
		expect(formatCreatedDate.length).toBeLessThanOrEqual(3);
	});
});

describe('formatFullDate', () => {
	it('renders the full local date and time', () => {
		const iso = localIso(2026, 9, 24, 15, 13);
		expect(formatFullDate(iso, LOCAL)).toBe('Oct 24, 2026, 3:13 PM');
	});

	it('uses 12-hour clock labels from the locale', () => {
		const iso = localIso(2026, 9, 24, 0, 5);
		expect(formatFullDate(iso, LOCAL)).toBe('Oct 24, 2026, 12:05 AM');
	});

	it('returns an empty string for an unparseable timestamp', () => {
		expect(formatFullDate('nope', LOCAL)).toBe('');
	});
});
