import { expect, test } from '@playwright/test';
import { hydration } from '../helpers/keyboard';
import { rows, seedNote, seedNotes, waitForList } from '../helpers/seed';
import { editorBody, editorStatus, sweepWidths } from './support';

/**
 * Story 2 — **Create a note**.
 *
 * Epic #1: "'New note' opens an empty editor with focus; the note is persisted
 * on its first non-whitespace character; a note left empty is discarded."
 *
 * ## Reuse
 *
 * #7's `note-editor.spec.ts` proves the three clauses on Chromium, including
 * the caret-preserving shallow URL rewrite on the first character. What this
 * file adds is what only acceptance testing asks: the journey a user takes from
 * the list (not from a typed URL), at every engine and width, and the two
 * entry points that exist (#6's empty-state button and the header action).
 */

/** Every note id in storage right now, straight from IndexedDB. */
function storedIds(page: import('@playwright/test').Page): Promise<string[]> {
	return page.evaluate(async () => {
		const open = () =>
			new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('notes-app');
				request.addEventListener('success', () => resolve(request.result));
				request.addEventListener('error', () => reject(request.error));
			});
		const db = await open();
		try {
			const notes = await new Promise<{ id: string; body: string }[]>((resolve, reject) => {
				const request = db.transaction('notes', 'readonly').objectStore('notes').getAll();
				request.addEventListener('success', () => resolve(request.result));
				request.addEventListener('error', () => reject(request.error));
			});
			return notes.map((note) => note.id);
		} finally {
			db.close();
		}
	});
}

test.describe('story 2 — Create a note', () => {
	for (const entry of [
		{
			name: 'the empty-state "New note" button',
			locate: (page: import('@playwright/test').Page) =>
				page.getByTestId('note-list-empty').getByRole('link', { name: 'New note' })
		},
		{
			name: 'the header "New note" action',
			locate: (page: import('@playwright/test').Page) =>
				page.getByRole('banner').getByRole('link', { name: 'New note' })
		}
	]) {
		test(`AC1: ${entry.name} opens an empty, focused editor`, async ({ page }) => {
			await seedNotes(page, []);
			await waitForList(page);

			await entry.locate(page).click();
			await hydration(page);

			await expect(page).toHaveURL(/\/notes\/new$/);
			const body = editorBody(page);
			await expect(body).toBeVisible();
			await expect(body).toHaveValue('');
			// Focus is what lets a user start typing without aiming at the box.
			await expect(body).toBeFocused();
		});
	}

	test('AC2: the note is persisted on the first non-whitespace character', async ({ page }) => {
		await seedNotes(page, []);
		await waitForList(page);
		await page.goto('/notes/new');
		await hydration(page);

		// Whitespace is not content: nothing is stored, and the URL stays `/new`.
		await page.keyboard.type('   ');
		expect(await storedIds(page)).toEqual([]);
		await expect(page).toHaveURL(/\/notes\/new$/);

		// The first real character creates the note and gives it a URL.
		await page.keyboard.type('H');
		await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}$/);
		expect(await storedIds(page)).toHaveLength(1);
	});

	test('AC3: a note left empty is discarded', async ({ page }) => {
		await seedNotes(page, []);
		await waitForList(page);
		await page.goto('/notes/new');
		await hydration(page);

		await page.keyboard.type('    ');
		await page.getByRole('heading', { level: 1 }).getByRole('link', { name: 'Notes' }).click();
		await expect(page).toHaveURL('/');

		// Nothing to keep, so nothing is stored and the empty state is honest.
		expect(await storedIds(page)).toEqual([]);
		await expect(page.getByTestId('note-list-empty')).toBeVisible();
	});

	test('AC4: creating a note through the list adds exactly one row', async ({ page }) => {
		await seedNotes(page, [seedNote(1, 'An existing note', new Date().toISOString())]);
		await waitForList(page);
		await expect(rows(page)).toHaveCount(1);

		await page.getByRole('banner').getByRole('link', { name: 'New note' }).click();
		// The shell is already mounted from the list route, so waiting for it
		// proves nothing about this navigation: wait for the URL *and* for the
		// new editor to own focus, which is the state typing depends on.
		await expect(page).toHaveURL(/\/notes\/new$/);
		// A new note opens focused, so typing needs no aiming.
		await expect(page.getByRole('textbox', { name: 'Note' })).toBeFocused();
		await page.keyboard.type('A brand new note');
		await expect(editorStatus(page)).toHaveText('Saved');

		// Leaving through the header title is an in-app navigation at every
		// width (the back link is mobile-only), so this exercises the SvelteKit
		// flush path everywhere rather than a width-specific shortcut.
		await page.getByRole('heading', { level: 1 }).getByRole('link', { name: 'Notes' }).click();
		await expect(page).toHaveURL('/');
		await waitForList(page);
		await expect(rows(page)).toHaveCount(2);
	});

	test('AC5: no horizontal overflow while creating a note, at 320 through 1920 px', async ({
		page
	}, testInfo) => {
		await seedNotes(page, []);
		await waitForList(page);
		await page.goto('/notes/new');
		await hydration(page);
		await page.keyboard.type('A note being created at every width');
		await expect(editorStatus(page)).toHaveText('Saved');

		await sweepWidths(page, testInfo, 'story-2 new note editor');
	});
});
