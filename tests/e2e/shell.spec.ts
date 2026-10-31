import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { rows, seedNote, seedNotes, waitForList } from './helpers/seed';

const LIST = '[data-pane="list"]';
const EDITOR = '[data-pane="editor"]';

const paneVisible = (page: Page, selector: string) =>
	page.locator(selector).evaluate((el) => {
		const style = getComputedStyle(el);
		const box = el.getBoundingClientRect();
		return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0;
	});

/**
 * The app is a client-rendered SPA, so the shell only becomes focusable once
 * hydration finishes (the skip link is a real element from the start, but the
 * document body owns focus until then).
 */
const hydration = (page: Page) =>
	page.waitForFunction(() => document.querySelector('[data-slot="app-shell"]') !== null);

/** Runs axe and returns only serious/critical violations, ready for the assert. */
const seriousAxeViolations = async (page: Page, context: string) => {
	const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
	return violations
		.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
		.map((violation) => ({
			id: violation.id,
			impact: violation.impact,
			context,
			nodes: violation.nodes.map((node) => node.target.join(' '))
		}));
};

test.describe('app shell panes', () => {
	test('list view: the list is always visible, the editor pane only from md up', async ({
		page
	}, testInfo) => {
		const wide = (page.viewportSize()?.width ?? 0) >= 768;
		await page.goto('/');
		await hydration(page);

		expect(await paneVisible(page, LIST)).toBe(true);
		expect(await paneVisible(page, EDITOR)).toBe(wide);

		const hint = page.getByText('Select a note or create a new one');
		if (wide) {
			await expect(hint).toBeVisible();
			// Two panes: the sidebar keeps its ~320 px slot next to the editor.
			const sidebar = await page.locator(LIST).boundingBox();
			expect(sidebar?.width).toBeGreaterThanOrEqual(300);
			expect(sidebar?.width).toBeLessThanOrEqual(340);
			expect(await page.locator(EDITOR).boundingBox()).not.toBeNull();
			expect(testInfo.project.name).not.toBe('mobile');
		} else {
			await expect(hint).toBeHidden();
		}
	});

	test('note view: editor only on mobile, sidebar + editor from md up', async ({
		page
	}, testInfo) => {
		const wide = (page.viewportSize()?.width ?? 0) >= 768;
		// The list is storage-backed since #6, so the "current" highlight needs a
		// note that actually exists.
		const [note] = await seedNotes(page, [seedNote(1, 'Current note', new Date().toISOString())]);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);

		expect(await paneVisible(page, EDITOR)).toBe(true);
		expect(await paneVisible(page, LIST)).toBe(wide);

		const back = page.getByRole('link', { name: 'Back to notes' });
		if (wide) {
			await expect(back).toBeHidden();
			await expect(page.locator(`${LIST} [aria-current="page"]`)).toBeVisible();
			expect(testInfo.project.name).not.toBe('mobile');
		} else {
			await expect(back).toBeVisible();
			await expect(back).toHaveAttribute('href', '/');
			await expect(back).toHaveAccessibleName('Back to notes');
		}
	});

	test('the back button returns to the list on mobile', async ({ page }) => {
		test.skip(test.info().project.name !== 'mobile', 'mobile-only affordance');

		await page.goto('/notes/some-id');
		await hydration(page);
		await page.getByRole('link', { name: 'Back to notes' }).click();

		await expect(page).toHaveURL('/');
		expect(await paneVisible(page, LIST)).toBe(true);
		expect(await paneVisible(page, EDITOR)).toBe(false);
	});

	test('new-note route uses the editor pane on every viewport', async ({ page }) => {
		const wide = (page.viewportSize()?.width ?? 0) >= 768;
		await page.goto('/notes/new');
		await hydration(page);

		expect(await paneVisible(page, EDITOR)).toBe(true);
		expect(await paneVisible(page, LIST)).toBe(wide);
		// The static segment wins over `/notes/[id]`: the editor reports "no id"
		// rather than an id of "new".
		await expect(page.getByText('(new note)')).toBeVisible();
		// A not-yet-existing note is not in the list, so nothing is current.
		await expect(page.locator('[aria-current="page"]')).toHaveCount(0);
	});
});

test.describe('layout invariants', () => {
	for (const route of ['/', '/notes/some-id']) {
		test(`no horizontal overflow at 320px on ${route}`, async ({ page }) => {
			await page.setViewportSize({ width: 320, height: 568 });
			await page.goto(route);
			await hydration(page);

			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				320
			);
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
			).toBeLessThanOrEqual(0);
		});

		test(`no nested page scrollbar on ${route}`, async ({ page }) => {
			await page.goto(route);
			await hydration(page);

			// The shell fills 100dvh and each pane scrolls itself: the document
			// itself must never scroll vertically.
			const docScrollable = await page.evaluate(
				() => document.documentElement.scrollHeight > document.documentElement.clientHeight + 1
			);
			expect(docScrollable).toBe(false);
		});
	}

	test('header controls are at least 44x44 px', async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 667 });
		await page.goto('/notes/some-id');
		await hydration(page);

		for (const name of ['Back to notes', 'Notes']) {
			const box = await page.getByRole('link', { name, exact: true }).boundingBox();
			expect(box?.width, `${name} width`).toBeGreaterThanOrEqual(44);
			expect(box?.height, `${name} height`).toBeGreaterThanOrEqual(44);
		}
	});

	test('skip link sends keyboard focus into the main region', async ({ page }) => {
		await page.goto('/');
		await hydration(page);

		// The skip link is the first thing Tab reaches.
		await page.keyboard.press('Tab');
		const skip = page.getByRole('link', { name: 'Skip to content' });
		await expect(skip).toBeFocused();

		await page.keyboard.press('Enter');
		await expect(page.locator('#main')).toBeFocused();
	});

	test('tab order runs skip link → header → list', async ({ page }) => {
		// Below md the list is not rendered for `/notes/*`, so it cannot be in
		// the tab order: the assertion is about the two-pane layout.
		test.skip((page.viewportSize()?.width ?? 0) < 768, 'two-pane layout only');

		// The note has to exist: `activeNoteId` only highlights a row that the
		// storage-backed list actually loads.
		await seedNotes(page, [seedNote(1, 'A note to focus', new Date().toISOString())]);

		await page.goto('/notes/some-id');
		await hydration(page);
		// Hydration only proves the shell is mounted. The list is storage-backed
		// and async, so at this instant it still draws its skeleton — a `<ul>`
		// marked `aria-hidden` with no focusable row in it. Tabbing here used to
		// run through the whole page before the rows arrived (the race that made
		// this test flaky under load) and the first stops never reached the list.
		// Wait for the list's settled, focusable state instead of for the shell.
		await waitForList(page);
		await expect(rows(page).first()).toBeVisible();

		/**
		 * Which region owns focus, plus whether the stop is a note row. The row
		 * flag is what `list` ultimately has to mean, so the walk below can stop
		 * there even when a sibling branch adds another focusable element inside
		 * the same pane.
		 */
		const focusState = () =>
			page.evaluate(
				({ list, editor }) => {
					const active = document.activeElement as HTMLElement | null;
					if (!active) return { zone: 'none', isRow: false };
					const isRow = active.closest('[data-slot="note-row"]') !== null;
					if (active.dataset.testid === 'skip-link') return { zone: 'skip', isRow };
					if (active.closest('header')) return { zone: 'header', isRow };
					if (active.closest(list)) return { zone: 'list', isRow };
					if (active.closest(editor)) return { zone: 'editor', isRow };
					return { zone: 'other', isRow };
				},
				{ list: LIST, editor: EDITOR }
			);

		// Bound the walk by the number of tab stops the page actually has, not a
		// hard-coded count: a branch that adds a control (e.g. #10's storage
		// notice, one more stop between the header and the list) changes how many
		// presses it takes, never whether the order is right.
		const tabStops = await page.evaluate(() => {
			const selector = 'a[href], button, input, select, textarea, [tabindex]';
			return [...document.querySelectorAll<HTMLElement>(selector)].filter(
				(element) => element.tabIndex >= 0
			).length;
		});
		expect(tabStops).toBeGreaterThan(0);

		// Walk the real tab order until focus lands on a note row, keeping only
		// the zones this test names and collapsing repeats: the assertion is
		// about the order of the named regions, not about how many focusable
		// elements each one happens to contain, and not about unrelated chrome a
		// sibling branch may add (an unknown stop is skipped here, and a notice
		// inside the list pane is still `list` on the way to a row).
		const order: string[] = [];
		for (let press = 0; press <= tabStops; press += 1) {
			await page.keyboard.press('Tab');
			const { zone, isRow } = await focusState();
			if (zone !== 'other' && zone !== 'none') order.push(zone);
			if (isRow) break;
		}

		const sequence = order.filter((zone, index) => zone !== order[index - 1]);
		expect(sequence).toContain('list');
		// Order, not just reachability: the skip link comes before the header,
		// the header before the list, and the editor pane is never on the way.
		expect(sequence.slice(0, 3)).toEqual(['skip', 'header', 'list']);
		expect(sequence).not.toContain('editor');

		// And the stop that received focus really is a row — the list's own tab
		// stop — not the skeleton, and not some other element inside the pane.
		await expect(rows(page).first()).toBeFocused();
	});
});

test.describe('accessibility', () => {
	for (const route of ['/', '/notes/some-id', '/notes/new']) {
		test(`axe reports no serious or critical violations on ${route}`, async ({
			page
		}, testInfo) => {
			await page.goto(route);
			await hydration(page);
			await expect(page.getByRole('banner')).toBeVisible();
			await expect(page.getByRole('main')).toBeVisible();

			const violations = await seriousAxeViolations(page, `${route} @ ${testInfo.project.name}`);
			expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
		});
	}
});
