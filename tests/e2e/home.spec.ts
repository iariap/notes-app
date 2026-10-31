import { expect, test } from '@playwright/test';

const horizontalOverflow = (page: import('@playwright/test').Page) =>
	page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test('home page renders the "Notes" heading without horizontal scroll', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByRole('heading', { level: 1, name: 'Notes' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'New note' })).toBeVisible();

	expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test('home page does not scroll horizontally at 320px width', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 568 });
	await page.goto('/');

	await expect(page.getByRole('heading', { level: 1, name: 'Notes' })).toBeVisible();
	expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});
