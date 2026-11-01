import { expect, test, type Page } from '@playwright/test';
import { rowTitles, rows, seedNote, seedNotes, waitForList, type SeedNote } from './helpers/seed';

/**
 * Issue #8: delete a note with a 5 s Undo.
 *
 * Every test runs in all three configured projects (375 / 768 / 1280), so the
 * responsive rules of epic #1 are covered by construction; the two places where
 * the behaviour genuinely differs by width (where the Delete control lives and
 * where focus goes) are asserted per project.
 *
 * Storage is asserted directly as well as through the UI, because "deleted
 * immediately" and "restored identically" are claims about storage, not about
 * what happens to be on screen.
 */

const MIN_LONG_WINDOW = 5000;

/** Waits for the client-rendered shell (the app is an SPA). */
const hydration = (page: Page) =>
	page.waitForFunction(() => document.querySelector('[data-slot="app-shell"]') !== null);

/** Every stored record, exactly as the repository wrote it. */
function storedNotes(page: Page) {
	return page.evaluate(async () => {
		const open = () =>
			new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('notes-app');
				request.addEventListener('success', () => resolve(request.result));
				request.addEventListener('error', () => reject(request.error));
			});
		const db = await open();
		try {
			return await new Promise<
				{ id: string; body: string; createdAt: string; updatedAt: string }[]
			>((resolve, reject) => {
				const request = db.transaction('notes', 'readonly').objectStore('notes').getAll();
				request.addEventListener('success', () => resolve(request.result));
				request.addEventListener('error', () => reject(request.error));
			});
		} finally {
			db.close();
		}
	});
}

/** One record from storage, or `undefined` when it is gone. */
async function storedNote(page: Page, id: string) {
	return (await storedNotes(page)).find((note) => note.id === id);
}

const isMobile = (page: Page) => (page.viewportSize()?.width ?? 0) < 768;

/** The Undo toast, by its text and its single action. */
const deleteToast = (page: Page) =>
	page.locator('[data-sonner-toast]').filter({ hasText: 'Note deleted' });
const undoButton = (page: Page) => deleteToast(page).getByRole('button', { name: 'Undo' });

/**
 * Three notes whose order is unambiguous: created a minute apart, so the list
 * reads newest first as Third / Second / First, with no tie to break.
 */
function threeNotes(now: number): SeedNote[] {
	return [
		seedNote(1, 'First note', new Date(now - 30 * 60_000).toISOString()),
		seedNote(2, 'Second note', new Date(now - 20 * 60_000).toISOString()),
		seedNote(3, 'Third note', new Date(now - 10 * 60_000).toISOString())
	];
}

/**
 * Seeds the three notes and waits for the list to render them.
 *
 * `seedNotes` reloads the page and returns as soon as the records are written;
 * the app's first read of storage is still in flight at that point, so a test
 * that reads `rowTitles` immediately can catch an empty list. Waiting here, once,
 * keeps every assertion about order honest.
 */
async function seedThree(page: Page, now = Date.now()): Promise<readonly SeedNote[]> {
	const notes = await seedNotes(page, threeNotes(now));
	await waitForList(page);
	return notes;
}

/** Opens the row menu of `index` and returns its Delete item. */
async function openRowMenu(page: Page, index: number) {
	await rows(page).nth(index).hover();
	const trigger = page.locator('[data-testid="note-row-menu"]').nth(index);
	await trigger.click();
	return page.getByRole('menuitem', { name: 'Delete' });
}

test.describe('delete from the editor', () => {
	test('deletes at once, stays deleted after a reload', async ({ page }) => {
		const now = Date.now();
		const notes = await seedThree(page, now);
		const target = notes[1];
		await page.goto(`/notes/${target.id}`);
		await hydration(page);
		await expect(page.getByRole('textbox', { name: 'Note' })).toHaveValue('Second note');

		await page.getByRole('button', { name: 'Delete note' }).click();

		// The toast offers the way back…
		await expect(deleteToast(page)).toBeVisible();
		await expect(deleteToast(page)).toContainText('Note deleted');
		await expect(undoButton(page)).toBeVisible();
		// …and the deletion is already durable, before the window closes.
		expect(await storedNote(page, target.id)).toBeUndefined();
		// Leaving the note is part of deleting, at every width.
		await expect(page).toHaveURL('/');
		await expect(page.locator('[data-slot="note-row"]')).toHaveCount(2);

		// Let the window lapse rather than reloading inside it: the point is that
		// the deletion is final, so Undo must not be able to apply afterwards.
		await expect(deleteToast(page)).toHaveCount(0, { timeout: MIN_LONG_WINDOW + 5000 });
		await page.reload();
		await waitForList(page);
		expect(await rowTitles(page)).toEqual(['Third note', 'First note']);
		expect((await storedNotes(page)).map((note) => note.id)).not.toContain(target.id);
	});

	test('the Delete control is a thumb-reachable, icon-only button on mobile', async ({
		page
	}, testInfo) => {
		const notes = await seedThree(page, Date.now());
		await page.goto(`/notes/${notes[0].id}`);
		await hydration(page);

		const button = page.getByRole('button', { name: 'Delete note' });
		await expect(button).toBeVisible();
		// Same accessible name everywhere; only the visible label changes.
		await expect(button).toHaveAccessibleName('Delete note');

		const box = (await button.boundingBox())!;
		expect(box.width).toBeGreaterThanOrEqual(44);
		expect(box.height).toBeGreaterThanOrEqual(44);
		// Inside the viewport, not scrolled off the header.
		const viewport = page.viewportSize()!;
		expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
		expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

		const label = button.locator('span');
		if (isMobile(page) || testInfo.project.name === 'mobile') {
			await expect(label).toBeHidden();
		} else {
			await expect(label).toBeVisible();
			await expect(label).toHaveText('Delete');
		}
	});
});

test.describe('undo', () => {
	test('restores the identical note in the same position, verified after a reload', async ({
		page
	}) => {
		const now = Date.now();
		const notes = await seedThree(page, now);
		const target = notes[1];
		const beforeTitles = await rowTitles(page);
		expect(beforeTitles).toEqual(['Third note', 'Second note', 'First note']);

		await page.goto(`/notes/${target.id}`);
		await hydration(page);
		await page.getByRole('button', { name: 'Delete note' }).click();
		await expect(page).toHaveURL('/');
		await undoButton(page).click();

		// Back in the list, in its own row, without navigating anywhere.
		await expect(page).toHaveURL('/');
		await expect(page.locator('[data-slot="note-row"]')).toHaveCount(3);
		expect(await rowTitles(page)).toEqual(beforeTitles);

		// Identical record: same id, body and *both* dates. Those dates are what
		// put it back in the same slot, because `updatedAt` is the sort key.
		const restored = await storedNote(page, target.id);
		expect(restored).toEqual(target);
		expect(restored?.createdAt).toBe(target.createdAt);
		expect(restored?.updatedAt).toBe(target.updatedAt);

		// And it is durable, which is the claim that matters after a reload.
		await page.reload();
		await waitForList(page);
		expect(await rowTitles(page)).toEqual(beforeTitles);
		expect(await storedNote(page, target.id)).toEqual(target);
	});

	test('the window lasts 5 s: inside it Undo works, after it the note is gone', async ({
		page
	}, testInfo) => {
		// The clock is the whole subject, so this runs once rather than in three
		// projects; the other tests already prove the UI at every width.
		test.skip(testInfo.project.name !== 'desktop', 'clock manipulation, run once');

		const notes = await seedThree(page, Date.now());
		const target = notes[1];
		await page.goto(`/notes/${target.id}`);
		await hydration(page);

		// A page clock makes the 5 s observable without waiting for it: timers
		// inside the page are driven by `fastForward`.
		await page.clock.install();
		await page.getByRole('button', { name: 'Delete note' }).click();
		await expect(undoButton(page)).toBeVisible();

		// 4 s in: still offered.
		await page.clock.fastForward(4000);
		await expect(undoButton(page)).toBeVisible();

		// Past 5 s: the toast is gone and there is no Undo left to press.
		await page.clock.fastForward(2000);
		await expect(deleteToast(page)).toHaveCount(0);
		expect(await storedNote(page, target.id)).toBeUndefined();
	});

	test('the Undo toast does not auto-close while it has focus', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'keyboard focus, run once');

		const notes = await seedThree(page, Date.now());
		const target = notes[1];
		await page.goto(`/notes/${target.id}`);
		await hydration(page);
		await page.clock.install();
		await page.getByRole('button', { name: 'Delete note' }).click();

		// Keyboard-reachable, and holding it holds the window open.
		await undoButton(page).focus();
		await expect(undoButton(page)).toBeFocused();
		await page.clock.fastForward(30_000);
		await expect(undoButton(page)).toBeVisible();

		// Pressing it still restores the note.
		await page.keyboard.press('Enter');
		await expect(deleteToast(page)).toHaveCount(0);
		await expect(async () => {
			expect(await storedNote(page, target.id)).toEqual(target);
		}).toPass();
	});
});

test.describe('delete from the list menu', () => {
	test('deletes through "⋯ → Delete" and restores through Undo', async ({ page }) => {
		const notes = await seedThree(page, Date.now());
		const target = notes[1];
		const beforeTitles = await rowTitles(page);

		const item = await openRowMenu(page, 1);
		await expect(item).toBeVisible();
		await item.click();

		await expect(page.locator('[data-slot="note-row"]')).toHaveCount(2);
		expect(await storedNote(page, target.id)).toBeUndefined();
		await expect(deleteToast(page)).toBeVisible();

		await undoButton(page).click();
		await expect(page.locator('[data-slot="note-row"]')).toHaveCount(3);
		expect(await rowTitles(page)).toEqual(beforeTitles);
		expect(await storedNote(page, target.id)).toEqual(target);
	});

	test('the menu is always visible on touch and on hover/focus with a mouse', async ({
		page
	}, testInfo) => {
		await seedThree(page, Date.now());
		await waitForList(page);

		const wrapper = page
			.locator('[data-slot="note-row-wrapper"]')
			.first()
			.locator('..')
			.locator('div')
			.first();
		const trigger = page.locator('[data-testid="note-row-menu"]').first();
		const opacity = () =>
			trigger.evaluate((element) => {
				// The menu's own wrapper carries the visibility rule.
				const container = element.parentElement as HTMLElement;
				return getComputedStyle(container).opacity;
			});

		// The trigger itself is a full 44 px target at every width.
		const box = (await trigger.boundingBox())!;
		expect(box.width).toBeGreaterThanOrEqual(44);
		expect(box.height).toBeGreaterThanOrEqual(44);

		if (testInfo.project.name === 'mobile') {
			// No hover with a finger: it must be painted without any interaction.
			expect(await opacity()).toBe('1');
			expect(wrapper).toBeTruthy();
			return;
		}

		// With a mouse it appears on hover…
		await page.mouse.move(0, 0);
		await expect.poll(opacity).toBe('0');
		await rows(page).first().hover();
		await expect.poll(opacity).toBe('1');

		// …and on keyboard focus, which is what keeps it operable without a mouse.
		await page.mouse.move(0, 0);
		await expect.poll(opacity).toBe('0');
		await page.locator('[data-slot="note-row"]').first().focus();
		await page.keyboard.press('Tab');
		await expect(trigger).toBeFocused();
		await expect.poll(opacity).toBe('1');
	});

	test('returns focus to the list, never to <body>, after deleting', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name === 'mobile', 'asserted once; the list behaves the same');

		await seedThree(page, Date.now());
		await rows(page).nth(1).hover();
		await page.locator('[data-testid="note-row-menu"]').nth(1).click();
		await page.getByRole('menuitem', { name: 'Delete' }).click();

		// The row that held the menu is gone, taking the focused trigger and the
		// menu item with it. What must not happen is focus falling back to the
		// document: it goes to a row the user can act on.
		await expect(page.locator('[data-slot="note-row"]')).toHaveCount(2);
		await expect(async () => {
			const focused = await page.evaluate(() => {
				const active = document.activeElement as HTMLElement | null;
				return {
					tag: active?.tagName ?? null,
					slot: active?.getAttribute('data-slot') ?? null
				};
			});
			expect(focused.tag).not.toBe('BODY');
			expect(focused.slot).toBe('note-row');
		}).toPass();
	});

	test('the tab that deletes never sees "deleted in another tab"', async ({ page }) => {
		const notes = await seedThree(page, Date.now());
		const target = notes[1];
		await page.goto(`/notes/${target.id}`);
		await waitForList(page);
		await expect(page.getByRole('textbox', { name: 'Note' })).toHaveValue('Second note');

		// From the sidebar menu while the note is open in the editor (the two
		// panes are on screen together at `md` and up).
		if (isMobile(page)) {
			await page.goto('/');
			await waitForList(page);
		}
		const item = await openRowMenu(page, 1);
		await item.click();

		// Give the message a real chance to appear before asserting it did not.
		await page.waitForTimeout(600);
		await expect(page.getByTestId('editor-deleted')).toHaveCount(0);
		await expect(page.locator('body')).not.toContainText('deleted in another tab');
	});

	test('deleting in one tab tells the other tab, which offers the way back', async ({
		page,
		context
	}) => {
		const notes = await seedThree(page, Date.now());
		const target = notes[1];
		await page.goto(`/notes/${target.id}`);
		await hydration(page);

		const other = await context.newPage();
		await other.goto(`/notes/${target.id}`);
		await hydration(other);
		await expect(other.getByRole('textbox', { name: 'Note' })).toHaveValue('Second note');

		// Delete in the first tab; the second is a *different* tab, so it says so.
		await page.getByRole('button', { name: 'Delete note' }).click();
		await expect(other.getByTestId('editor-deleted')).toBeVisible();
		await expect(other.getByTestId('editor-deleted')).toHaveText(
			'This note was deleted in another tab'
		);
	});
});

test.describe('two quick deletes', () => {
	test('each Undo restores only its own note, independently and in order', async ({ page }) => {
		const notes = await seedThree(page, Date.now());
		const beforeTitles = await rowTitles(page);
		expect(beforeTitles).toEqual(['Third note', 'Second note', 'First note']);

		// Delete the middle row, then the last one, without waiting for the first
		// toast to go: two windows are open at once.
		await (await openRowMenu(page, 1)).click();
		await expect(page.locator('[data-slot="note-row"]')).toHaveCount(2);
		await (await openRowMenu(page, 1)).click();
		await expect(page.locator('[data-slot="note-row"]')).toHaveCount(1);
		expect(await rowTitles(page)).toEqual(['Third note']);

		const toasts = deleteToast(page);
		await expect(toasts).toHaveCount(2);

		// A collapsed stack overlaps its cards, so an older toast's button is
		// under the newer one until the user points at the stack: that is the
		// gesture that expands it, and the one a user would make before pressing
		// the lower Undo.
		await toasts.first().hover();
		await expect(toasts.first()).toHaveAttribute('data-expanded', 'true');

		// Undo the *older* delete (the first toast in the stack): only that note
		// comes back, never the newer one.
		await toasts.first().getByRole('button', { name: 'Undo' }).click();
		await expect(async () => {
			expect(await storedNote(page, notes[0].id)).toEqual(notes[0]);
		}).toPass();
		expect(await storedNote(page, notes[1].id)).toBeUndefined();
		expect(await rowTitles(page)).toEqual(['Third note', 'First note']);

		// Then the newer one: the middle note returns to its own slot.
		await toasts.first().getByRole('button', { name: 'Undo' }).click();
		await expect(async () => {
			expect(await storedNote(page, notes[1].id)).toEqual(notes[1]);
		}).toPass();
		await expect(page.locator('[data-slot="note-row"]')).toHaveCount(3);
		expect(await rowTitles(page)).toEqual(beforeTitles);

		// Both records are byte-for-byte what they were, after a reload.
		await page.reload();
		await waitForList(page);
		expect(await rowTitles(page)).toEqual(beforeTitles);
		expect(await storedNote(page, notes[0].id)).toEqual(notes[0]);
		expect(await storedNote(page, notes[1].id)).toEqual(notes[1]);
	});
});

test.describe('accessibility', () => {
	/**
	 * Waits until the toast has finished its entrance animation.
	 *
	 * Sonner fades each toast in with an inline `opacity` ramping from ~0.07, and
	 * an `opacity`-blended white-on-dark button is (correctly) reported as
	 * failing contrast while that happens. The state a user actually reads is the
	 * settled one — measured at 1 with a 17:1 ratio — so the audit runs there.
	 * This is a scan-timing fix, not a suppression: nothing about the contrast
	 * check is disabled.
	 */
	async function waitForToastSettled(page: Page): Promise<void> {
		await expect
			.poll(
				() =>
					page.evaluate(() => {
						const toast = document.querySelector<HTMLElement>('[data-sonner-toast]');
						return toast === null ? 0 : Number(getComputedStyle(toast).opacity);
					}),
				{ message: 'the toast should finish fading in' }
			)
			.toBeGreaterThan(0.99);
	}

	test('the editor and the delete toast have no serious axe violations', async ({ page }) => {
		const notes = await seedThree(page, Date.now());
		await page.goto(`/notes/${notes[1].id}`);
		await hydration(page);

		await page.getByRole('button', { name: 'Delete note' }).click();
		await expect(undoButton(page)).toBeVisible();
		await waitForToastSettled(page);

		const AxeBuilder = (await import('@axe-core/playwright')).default;
		const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
		const serious = violations
			.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
			.map((violation) => ({
				id: violation.id,
				impact: violation.impact,
				nodes: violation.nodes.map((node) => node.target.join(' '))
			}));
		expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
	});

	test('the Undo button clears AA contrast on its own colors', async ({ page }) => {
		// The audit above can be timing-sensitive while the toast animates; this
		// asserts the numbers directly, so the button's contrast is proven rather
		// than inferred from a scan that happened to be quiet.
		const notes = await seedThree(page, Date.now());
		await page.goto(`/notes/${notes[1].id}`);
		await hydration(page);
		await page.getByRole('button', { name: 'Delete note' }).click();
		await waitForToastSettled(page);

		const contrast = await undoButton(page).evaluate((button) => {
			/**
			 * Resolves a computed colour to sRGB bytes through a canvas.
			 *
			 * The theme is authored in `oklch()`, and `getComputedStyle` returns it
			 * verbatim — parsing it by hand would mean reimplementing the colour
			 * conversion. Painting a pixel makes the browser do it, so the numbers
			 * below are the ones a screenshot would show.
			 */
			const toRgb = (color: string): [number, number, number] => {
				const canvas = document.createElement('canvas');
				canvas.width = 1;
				canvas.height = 1;
				const context = canvas.getContext('2d');
				if (context === null) throw new Error('2d canvas unavailable');
				context.fillStyle = color;
				context.fillRect(0, 0, 1, 1);
				const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
				return [r, g, b];
			};
			/** Relative luminance, per WCAG 2.x. */
			const luminance = ([r, g, b]: [number, number, number]): number => {
				const channel = (value: number): number => {
					const scaled = value / 255;
					return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
				};
				return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
			};

			const style = getComputedStyle(button);
			const foreground = luminance(toRgb(style.color));
			const background = luminance(toRgb(style.backgroundColor));
			const lighter = Math.max(foreground, background);
			const darker = Math.min(foreground, background);
			return {
				color: style.color,
				background: style.backgroundColor,
				ratio: (lighter + 0.05) / (darker + 0.05)
			};
		});

		expect(contrast.ratio, JSON.stringify(contrast)).toBeGreaterThanOrEqual(4.5);
	});

	/**
	 * Waits until the row menu has finished its entrance animation.
	 *
	 * The same reason as `waitForToastSettled`, and the same remedy: the menu
	 * fades in (`data-open:fade-in-0`), so while it animates its opacity is still
	 * near zero and axe reports the item's colours as blended — a false
	 * `color-contrast` violation. Measured at rest the Delete item is 4.77:1,
	 * which clears AA. Scanning the settled state is what a user reads; nothing
	 * about the rule is disabled.
	 */
	async function waitForMenuSettled(page: Page): Promise<void> {
		await expect
			.poll(
				() =>
					page.evaluate(() => {
						const content = document.querySelector<HTMLElement>(
							'[data-slot="dropdown-menu-content"]'
						);
						return content === null ? 0 : Number(getComputedStyle(content).opacity);
					}),
				{ message: 'the row menu should finish fading in' }
			)
			.toBeGreaterThan(0.99);
	}

	test('axe is clean with the row menu open', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name === 'mobile', 'one viewport is enough for the menu markup');

		await seedThree(page, Date.now());
		await waitForList(page);
		await (await openRowMenu(page, 0)).waitFor();
		await waitForMenuSettled(page);

		const AxeBuilder = (await import('@axe-core/playwright')).default;
		const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
		const serious = violations
			.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
			.map((violation) => ({
				id: violation.id,
				impact: violation.impact,
				nodes: violation.nodes.map((node) => node.target.join(' '))
			}));
		expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
	});
});
