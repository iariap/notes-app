import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

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
		await page.goto('/notes/some-id');
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

		await page.goto('/notes/some-id');
		await hydration(page);

		const zoneOf = () =>
			page.evaluate(() => {
				const active = document.activeElement as HTMLElement | null;
				if (!active) return 'none';
				if (active.dataset.testid === 'skip-link') return 'skip';
				if (active.closest('header')) return 'header';
				if (active.closest('[data-pane="list"]')) return 'list';
				if (active.closest('[data-pane="editor"]')) return 'editor';
				return 'other';
			});

		const order: string[] = [];
		for (let i = 0; i < 8; i += 1) {
			await page.keyboard.press('Tab');
			order.push(await zoneOf());
		}

		// Collapse repeats so the assertion is about order, not about how many
		// focusable elements each zone happens to contain.
		const sequence = order.filter((zone, index) => zone !== order[index - 1]);
		expect(sequence.slice(0, 3)).toEqual(['skip', 'header', 'list']);
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
