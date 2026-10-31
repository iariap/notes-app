import { expect, test } from '@playwright/test';

/**
 * The one-time storage notice (#10, story 5 of the epic): it explains where the
 * notes live, is dismissible, and never comes back once dismissed.
 *
 * Runs across all three Playwright projects (375×667, 768×1024, 1280×800), so
 * the responsive assertions are exercised at each width instead of being
 * checked once at a single viewport.
 */

const NOTICE = '[data-testid="storage-notice"]';
const NOTICE_TEXT =
	"Your notes are stored only in this browser. Clearing browser data or using private mode will delete them. On iPhone/iPad, add the app to your Home Screen so Safari doesn't remove them after 7 days without use.";

test.describe('storage notice', () => {
	test('shows the exact copy on a first visit', async ({ page }) => {
		await page.goto('/');

		const notice = page.getByTestId('storage-notice');
		await expect(notice).toBeVisible();
		await expect(notice).toHaveText(new RegExp(NOTICE_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	});

	test('is dismissed by "OK, got it" and stays gone after a reload', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator(NOTICE)).toBeVisible();

		await page.getByRole('button', { name: 'OK, got it' }).click();
		await expect(page.locator(NOTICE)).toHaveCount(0);

		// Persisted, not just hidden in memory.
		expect(
			await page.evaluate(() => window.localStorage.getItem('notes.storageNoticeDismissed'))
		).toBe('true');

		await page.reload();
		await expect(page.getByRole('heading', { level: 1, name: 'Notes' })).toBeVisible();
		await expect(page.locator(NOTICE)).toHaveCount(0);
	});

	test('does not render on a later visit when the dismissal was already stored', async ({
		page
	}) => {
		await page.goto('/');
		await page.evaluate(() => window.localStorage.setItem('notes.storageNoticeDismissed', 'true'));

		await page.goto('/notes/some-id');

		await expect(page.getByRole('heading', { level: 1, name: 'Notes' })).toBeVisible();
		await expect(page.locator(NOTICE)).toHaveCount(0);
	});

	test('fits the viewport and keeps the header fully on screen', async ({ page }, testInfo) => {
		await page.goto('/');
		await expect(page.locator(NOTICE)).toBeVisible();

		const viewport = page.viewportSize()!;
		const notice = (await page.locator(NOTICE).boundingBox())!;
		const header = (await page.getByRole('banner').boundingBox())!;

		// No horizontal overflow anywhere the notice is on screen.
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth
			)
		).toBeLessThanOrEqual(0);

		// The notice is inside the viewport and starts below the header, so it can
		// never overlap or push out the "New note" button there.
		expect(notice.x).toBeGreaterThanOrEqual(0);
		expect(notice.x + notice.width).toBeLessThanOrEqual(viewport.width + 1);
		expect(notice.y).toBeGreaterThanOrEqual(header.y + header.height - 1);

		if (viewport.width >= 768) {
			// Sidebar column: the same ~320 px the shell gives the list.
			expect(notice.width).toBeGreaterThanOrEqual(300);
			expect(notice.width).toBeLessThanOrEqual(340);
			expect(testInfo.project.name).not.toBe('mobile');
		} else {
			// Full width below md.
			expect(notice.width).toBeGreaterThanOrEqual(viewport.width - 1);
		}

		// The dismiss button is a real touch target at every size.
		const button = (await page.getByRole('button', { name: 'OK, got it' }).boundingBox())!;
		expect(button.height).toBeGreaterThanOrEqual(44);
		expect(button.width).toBeGreaterThanOrEqual(44);
	});

	test('is reachable and dismissible with the keyboard', async ({ page }) => {
		await page.goto('/');

		const button = page.getByRole('button', { name: 'OK, got it' });
		await expect(page.locator(NOTICE)).toBeVisible();

		// The skip link is first, then the header's "New note", then the notice:
		// it is in the document order a keyboard user expects, not behind a trap.
		await page.keyboard.press('Tab');
		await expect(page.getByTestId('skip-link')).toBeFocused();
		const reached = await (async () => {
			for (let i = 0; i < 6; i += 1) {
				await page.keyboard.press('Tab');
				if (await button.evaluate((el) => el === document.activeElement)) return true;
			}
			return false;
		})();
		expect(reached).toBe(true);
		await expect(button).toBeFocused();

		await page.keyboard.press('Enter');
		await expect(page.locator(NOTICE)).toHaveCount(0);
	});

	test('keeps the shell usably tall on the smallest phone', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 568 });
		await page.goto('/');
		await expect(page.locator(NOTICE)).toBeVisible();

		// The notice must not eat the app: the list region keeps most of the
		// height so its first item is reachable without scrolling past the notice.
		const list = (await page.getByRole('region', { name: 'Notes' }).boundingBox())!;
		expect(list.height).toBeGreaterThan(568 * 0.4);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth
			)
		).toBeLessThanOrEqual(0);

		// It is the first thing in the list column, and dismissing it gives the
		// space back to the list.
		await page.getByRole('button', { name: 'OK, got it' }).click();
		const listAfter = (await page.getByRole('region', { name: 'Notes' }).boundingBox())!;
		expect(listAfter.height).toBeGreaterThan(list.height);
	});
});
