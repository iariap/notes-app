/**
 * Created-date formatting for the notes list.
 *
 * Product decision (epic #1): the list shows **when the note was created** in
 * the reader's local time, relative while it is recent ("2 hours ago",
 * "Yesterday") and absolute once it is older than a week ("Oct 24, 2026").
 * `updatedAt` is storage detail used for ordering and is never formatted here —
 * nothing in this module accepts it, so it cannot leak into the UI.
 *
 * Both formatters are pure: the clock and the locale are parameters, which is
 * what makes them testable with a fixed clock and a fixed `en-US` locale.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Relative phrasing is used below seven calendar days. */
export const RELATIVE_WINDOW_DAYS = 7;

/** Shown under one minute, where every relative unit would read as "0". */
export const JUST_NOW = 'just now';

const relativeCache = new Map<string, Intl.RelativeTimeFormat>();
const absoluteCache = new Map<string, Intl.DateTimeFormat>();
const fullCache = new Map<string, Intl.DateTimeFormat>();

function key(locale: string | undefined, kind: string): string {
	return `${locale ?? ''}\u0000${kind}`;
}

function relativeFormatter(locale: string | undefined): Intl.RelativeTimeFormat {
	const cacheKey = key(locale, 'relative');
	let formatter = relativeCache.get(cacheKey);
	if (!formatter) {
		// `numeric: 'auto'` is what produces "yesterday" instead of "1 day ago".
		formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
		relativeCache.set(cacheKey, formatter);
	}
	return formatter;
}

function absoluteFormatter(locale: string | undefined): Intl.DateTimeFormat {
	const cacheKey = key(locale, 'absolute');
	let formatter = absoluteCache.get(cacheKey);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat(locale, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
		absoluteCache.set(cacheKey, formatter);
	}
	return formatter;
}

function fullFormatter(locale: string | undefined): Intl.DateTimeFormat {
	const cacheKey = key(locale, 'full');
	let formatter = fullCache.get(cacheKey);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
		fullCache.set(cacheKey, formatter);
	}
	return formatter;
}

/**
 * Whole calendar days between two instants in the **reader's** time zone.
 *
 * Counting elapsed 24 h blocks would mislabel "yesterday at 23:00" read at
 * "today 22:00" (23 h → "23 hours ago") and "two days ago at 23:00" read at
 * "today 22:00" (47 h → "Yesterday", which is false). Comparing local midnights
 * makes the day unit agree with the calendar the user sees on the clock.
 */
function calendarDaysBetween(from: Date, to: Date): number {
	const startOf = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
	return Math.round((startOf(to) - startOf(from)) / (24 * HOUR));
}

/** `yesterday` → `Yesterday`: the day unit starts the row's date label. */
function capitalize(text: string): string {
	if (text.length === 0) return text;
	return `${text[0].toLocaleUpperCase()}${text.slice(1)}`;
}

/**
 * Label for a note's created date, in the reader's local time.
 *
 * - under 1 minute → `"just now"`
 * - under 1 hour → `"5 minutes ago"`
 * - under 24 hours → `"2 hours ago"`
 * - 1 to 6 calendar days → `"Yesterday"`, `"3 days ago"`
 * - 7 calendar days or more → the absolute local date, `"Oct 24, 2026"`
 *
 * A timestamp in the future (clock skew) reads as `"just now"` rather than a
 * negative count. An unparseable timestamp yields `''`, so the row renders
 * without a date instead of `Invalid Date`.
 *
 * ```ts
 * formatCreatedDate('2026-10-31T16:12:40.000Z', new Date('2026-10-31T16:13:00.000Z'), 'en-US')
 * // 'just now'
 * formatCreatedDate('2026-10-31T14:13:00.000Z', new Date('2026-10-31T16:13:00.000Z'), 'en-US')
 * // '2 hours ago'
 * formatCreatedDate('2026-10-24T15:00:00.000Z', new Date('2026-10-31T16:13:00.000Z'), 'en-US')
 * // 'Oct 24, 2026' (at UTC-3, the zone those timestamps were generated in)
 * ```
 */
export function formatCreatedDate(iso: string, now: Date = new Date(), locale?: string): string {
	const timestamp = Date.parse(iso);
	if (Number.isNaN(timestamp)) return '';
	const elapsed = now.getTime() - timestamp;
	if (elapsed < MINUTE) return JUST_NOW;
	if (elapsed < HOUR) {
		return relativeFormatter(locale).format(-Math.floor(elapsed / MINUTE), 'minute');
	}
	if (elapsed < 24 * HOUR) {
		return relativeFormatter(locale).format(-Math.floor(elapsed / HOUR), 'hour');
	}
	const days = calendarDaysBetween(new Date(timestamp), now);
	if (days < RELATIVE_WINDOW_DAYS) {
		// `days` is at least 1 here: more than 24 h have elapsed.
		return capitalize(relativeFormatter(locale).format(-Math.max(days, 1), 'day'));
	}
	return absoluteFormatter(locale).format(timestamp);
}

/**
 * Full local date and time, for the row tooltip and the open note's header:
 * `"Oct 24, 2026, 3:13 PM"` where the reader lives. `''` for an unparseable
 * timestamp.
 *
 * ```ts
 * formatFullDate('2026-10-24T18:13:00.000Z', 'en-US') // 'Oct 24, 2026, 3:13 PM' at UTC-3
 * ```
 */
export function formatFullDate(iso: string, locale?: string): string {
	const timestamp = Date.parse(iso);
	if (Number.isNaN(timestamp)) return '';
	return fullFormatter(locale).format(timestamp);
}
