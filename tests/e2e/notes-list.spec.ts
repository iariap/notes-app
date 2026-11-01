import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { rowTitles, rows, seedNote, seedNotes, waitForList, type SeedNote } from './helpers/seed';

/**
 * Issue #6: the notes list, its empty state and the created date.
 *
 * Every test seeds IndexedDB (there is no way to create a note through the UI
 * until #7), then asserts on what a user sees: order, titles, previews, dates
 * and navigation. The three configured projects (375 / 768 / 1280) run the same
 * assertions, so the responsive rules of epic #1 are covered by construction.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A body whose title and preview are unambiguous after Markdown stripping. */
function groceriesBody(extra = ''): string {
	return `# Groceries\n- [ ] buy milk\n- [x] eggs${extra}`;
}

/**
 * Three notes with distinct, stable relative labels: 2 hours, 3 days and 10
 * days. The older one falls outside the 7-day window, so it must render as an
 * absolute date instead of "10 days ago".
 */
function datedNotes(now: number): SeedNote[] {
	return [
		seedNote(1, groceriesBody(), new Date(now - 2 * HOUR).toISOString()),
		seedNote(2, 'Weekly plan\nShip the list view', new Date(now - 3 * DAY).toISOString()),
		seedNote(3, '**Old** note\n[docs](https://example.com)', new Date(now - 10 * DAY).toISOString())
	];
}

/** Seeds and waits for the list to render. */
async function openSeeded(page: Page, notes: readonly SeedNote[]): Promise<void> {
	await seedNotes(page, notes);
	await waitForList(page);
}

const horizontalOverflow = (page: Page) =>
	page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test.describe('notes list', () => {
	test('shows the seeded notes newest-edited first, with title, preview and date', async ({
		page
	}) => {
		const now = Date.now();
		await openSeeded(page, datedNotes(now));

		const titles = await rowTitles(page);
		expect(titles).toEqual(['Groceries', 'Weekly plan', 'Old note']);

		const first = rows(page).nth(0);
		await expect(first).toContainText('buy milk eggs');
		// Markdown is stripped from both lines, not shown raw.
		await expect(first).not.toContainText('#');
		await expect(first).not.toContainText('[ ]');
		await expect(first).not.toContainText('#');

		const second = rows(page).nth(1);
		await expect(second).toContainText('Ship the list view');

		const third = rows(page).nth(2);
		await expect(third).toContainText('docs');
		await expect(third).not.toContainText('](https://example.com)');
	});

	test('orders by most recently edited, not by creation', async ({ page }) => {
		const now = Date.now();
		// Created first, edited a minute ago: it belongs above a note created two
		// days ago and untouched since.
		const edited = seedNote(1, 'Edited most recently', new Date(now - 3 * DAY).toISOString());
		edited.updatedAt = new Date(now - MINUTE).toISOString();
		const untouched = seedNote(2, 'Untouched for two days', new Date(now - 2 * DAY).toISOString());
		await openSeeded(page, [untouched, edited]);

		const titles = await rowTitles(page);
		expect(titles).toEqual(['Edited most recently', 'Untouched for two days']);
		// The date shown is the *created* one, never `updatedAt`: the top row's
		// label comes from three days ago, not from a minute ago.
		await expect(rows(page).nth(0).locator('time')).toHaveText('3 days ago');
	});

	test('breaks ties deterministically when two notes share an updatedAt', async ({ page }) => {
		const now = Date.now();
		const same = new Date(now - 2 * HOUR).toISOString();
		await openSeeded(page, [seedNote(1, 'Seeded first', same), seedNote(2, 'Seeded second', same)]);

		// `id` descending breaks the tie, so the order is stable across reloads.
		const titles = await rowTitles(page);
		expect(titles).toEqual(['Seeded second', 'Seeded first']);
	});

	test('shows relative dates within the week and an absolute date beyond it', async ({ page }) => {
		const now = Date.now();
		await openSeeded(page, datedNotes(now));

		const dates = rows(page).locator('time');

		await expect(dates.nth(0)).toHaveText('2 hours ago');
		await expect(dates.nth(1)).toHaveText('3 days ago');
		// 10 days back: beyond the 7-day window, so the absolute date.
		await expect(dates.nth(2)).toHaveText(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
	});

	test('put the created ISO timestamp in datetime and the full date in title', async ({ page }) => {
		const now = Date.now();
		const notes = datedNotes(now);
		await openSeeded(page, notes);

		const time = rows(page).nth(0).locator('time');
		await expect(time).toHaveAttribute('datetime', notes[0].createdAt);
		// Full local date and time, e.g. "Oct 31, 2026, 10:13 AM".
		const title = await time.getAttribute('title');
		expect(title).toMatch(/\d{1,2}:\d{2}/);
		expect(title).toMatch(/\d{4}/);
	});

	test('reveals the same full date in a tooltip on focus', async ({ page }) => {
		await openSeeded(page, datedNotes(Date.now()));

		const row = rows(page).nth(0);
		const title = await row.locator('time').getAttribute('title');
		expect(title).toBeTruthy();

		// The tooltip is also reachable from the keyboard, not only on hover.
		await row.focus();
		await expect(page.locator('[data-slot="tooltip-content"]')).toBeVisible();
		await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(title as string);
	});

	test('ages the relative date on its own, without reloading the page', async ({
		page
	}, testInfo) => {
		// This one advances the browser's clock, so it runs once rather than in all
		// three projects: the behaviour is viewport-independent.
		test.skip(testInfo.project.name !== 'desktop', 'clock manipulation, run once');

		// Playwright's clock replaces `Date` and timers inside the page, so the
		// minute tick can be advanced instantly. Without it this test would wait up
		// to a real minute (and a loaded machine made that wait exceed the timeout).
		await page.clock.install({ time: new Date() });

		// Created 59 s before "now": the first reading is "just now", so the very
		// next tick must cross the one-minute boundary.
		const createdAt = new Date(Date.now() - 59_000).toISOString();
		await openSeeded(page, [seedNote(1, 'Fresh note', createdAt)]);

		// A marker that neither a reload nor a remount happened: `window` state
		// survives neither, and a reload re-runs this script.
		await page.evaluate(() => {
			(window as unknown as { __noReload: boolean }).__noReload = true;
		});

		const time = rows(page).nth(0).locator('time');
		await expect(time).toHaveText('just now');

		// Cross the next whole minute and let the interval fire: the label has to
		// change with no navigation, no reload and no storage write.
		await page.clock.fastForward('02:00');

		await expect(time).toHaveText(/minutes? ago/);
		expect(
			await page.evaluate(() => Boolean((window as unknown as { __noReload?: boolean }).__noReload))
		).toBe(true);
		await expect(time).toHaveAttribute('datetime', createdAt);
	});

	test('opens /notes/<id> when a row is clicked', async ({ page }, testInfo) => {
		const now = Date.now();
		const notes = datedNotes(now);
		await openSeeded(page, notes);

		await rows(page).nth(1).click();

		await expect(page).toHaveURL(new RegExp(`/notes/${notes[1].id}$`));
		// Below `md` the editor takes over the single column, so the list leaves
		// the accessibility tree (`getByRole` would not find it); from `md` up it
		// stays in the sidebar with the opened note highlighted.
		const listPane = page.locator('[data-pane="list"]');
		if (testInfo.project.name === 'mobile') {
			await expect(page.getByRole('link', { name: 'Back to notes' })).toBeVisible();
			expect(await listPane.evaluate((element) => getComputedStyle(element).display)).toBe('none');
		} else {
			await expect(listPane).toBeVisible();
			await expect(listPane.locator('[aria-current="page"]')).toHaveCount(1);
		}
	});

	test('keeps every row at least 44 px tall', async ({ page }) => {
		await openSeeded(page, datedNotes(Date.now()));

		const heights = await rows(page).evaluateAll((elements) =>
			elements.map((element) => element.getBoundingClientRect().height)
		);
		expect(heights).not.toHaveLength(0);
		for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
	});

	test('does not scroll horizontally at 320 px', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 568 });
		await openSeeded(page, datedNotes(Date.now()));

		expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
		// The list itself must not scroll sideways either.
		const listOverflow = await page
			.locator('[data-slot="note-list"]')
			.evaluate((element) => element.scrollWidth - element.clientWidth);
		expect(listOverflow).toBeLessThanOrEqual(1);
	});

	test('does not scroll horizontally at 320 px with a long unbroken title', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 568 });
		await openSeeded(page, [
			seedNote(1, `${'x'.repeat(400)}\n${'y'.repeat(400)}`, new Date().toISOString())
		]);

		expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
		// A single line with an ellipsis, not a wrapped wall of x's.
		const titleBox = await rows(page).nth(0).locator('span').first().boundingBox();
		expect(titleBox?.height ?? 0).toBeLessThan(40);
	});
});

test.describe('empty state', () => {
	test('shows "No notes yet" and a primary New note button', async ({ page }) => {
		await openSeeded(page, []);

		const empty = page.getByTestId('note-list-empty');
		await expect(empty).toBeVisible();
		await expect(empty).toContainText('No notes yet');

		const newNote = empty.getByRole('link', { name: 'New note' });
		await expect(newNote).toBeVisible();
		await expect(newNote).toHaveAttribute('href', '/notes/new');
	});

	test('the empty-state button opens /notes/new', async ({ page }) => {
		await openSeeded(page, []);

		const newNote = page.getByTestId('note-list-empty').getByRole('link', { name: 'New note' });
		// A primary call to action, at a full-size touch target.
		const box = await newNote.boundingBox();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
		expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
		await expect(newNote).toHaveAttribute('data-slot', 'button');

		await newNote.click();

		await expect(page).toHaveURL(/\/notes\/new$/);
	});

	test('the header New note action is available on every viewport', async ({ page }, testInfo) => {
		await openSeeded(page, []);

		const header = page.getByRole('banner').getByRole('link', { name: 'New note' });
		await expect(header).toBeVisible();
		await expect(header).toHaveAttribute('href', '/notes/new');

		// Touch target: at least 44×44 on every viewport, including the
		// icon-only mobile rendering.
		const box = await header.boundingBox();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
		expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);

		// Icon-only below `md`: the visible label is hidden, the accessible name is
		// not.
		const label = header.locator('span');
		if (testInfo.project.name === 'mobile') {
			await expect(label).toBeHidden();
			await expect(header).toHaveAccessibleName('New note');
		} else {
			await expect(label).toBeVisible();
		}
	});

	test('the header action opens /notes/new', async ({ page }) => {
		await openSeeded(page, []);

		await page.getByRole('banner').getByRole('link', { name: 'New note' }).click();

		await expect(page).toHaveURL(/\/notes\/new$/);
	});
});

test.describe('current note', () => {
	test('highlights the open note when the list is next to the editor', async ({
		page
	}, testInfo) => {
		test.skip(testInfo.project.name === 'mobile', 'the sidebar is hidden below md');

		const notes = datedNotes(Date.now());
		await openSeeded(page, notes);
		await page.goto(`/notes/${notes[1].id}`);
		await waitForList(page);

		const current = page.locator('[data-slot="note-row"][aria-current="page"]');
		await expect(current).toHaveCount(1);
		await expect(current).toHaveAttribute('href', `/notes/${notes[1].id}`);
		await expect(current).toContainText('Weekly plan');
	});

	test('marks nothing as current on the list route', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name === 'mobile', 'the sidebar is hidden below md');

		await openSeeded(page, datedNotes(Date.now()));

		await expect(page.locator('[aria-current="page"]')).toHaveCount(0);
	});
});

test.describe('accessibility', () => {
	test('axe reports no serious or critical violations with notes', async ({ page }, testInfo) => {
		await openSeeded(page, datedNotes(Date.now()));

		const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
		const serious = violations
			.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
			.map((violation) => ({
				id: violation.id,
				impact: violation.impact,
				context: testInfo.project.name,
				nodes: violation.nodes.map((node) => node.target.join(' '))
			}));

		expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
	});

	test('axe reports no serious or critical violations in the empty state', async ({
		page
	}, testInfo) => {
		await openSeeded(page, []);

		const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
		const serious = violations
			.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
			.map((violation) => ({
				id: violation.id,
				impact: violation.impact,
				context: testInfo.project.name,
				nodes: violation.nodes.map((node) => node.target.join(' '))
			}));

		expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
	});

	test('every row is reachable by keyboard', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name === 'mobile', 'one link per row, same behaviour everywhere');

		await openSeeded(page, datedNotes(Date.now()));

		const first = rows(page).nth(0);
		await first.focus();
		await expect(first).toBeFocused();

		// Since #8 each row contributes two stops: the note link, then its "⋯"
		// menu. Tabbing twice must reach the next row's link, so every note (and
		// its actions) is reachable without a pointer.
		await page.keyboard.press('Tab');
		await expect(page.locator('[data-testid="note-row-menu"]').nth(0)).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(rows(page).nth(1)).toBeFocused();
	});
});
