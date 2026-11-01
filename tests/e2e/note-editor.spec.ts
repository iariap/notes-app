import { expect, test, type Page } from '@playwright/test';
import { isNarrow } from './helpers/keyboard';

/**
 * Issue #7: the note editor and its autosave.
 *
 * The three configured projects (375 / 768 / 1280) run every test, so the
 * responsive rules of epic #1 are covered by construction. The assertions are
 * about what a user can observe: text survives a reload, leaving immediately
 * after typing still saves, an emptied note disappears, and two tabs converge.
 */

const EDITOR = '[data-pane="editor"]';

/** Waits for the client-rendered shell (the app is an SPA). */
const hydration = (page: Page) =>
	page.waitForFunction(() => document.querySelector('[data-slot="app-shell"]') !== null);

/** The editor's textarea, by its accessible label. */
const body = (page: Page) => page.getByRole('textbox', { name: 'Note' });

/** The polite status region in the editor header. */
const status = (page: Page) => page.getByTestId('editor-status');

/** Every note stored right now, straight from IndexedDB (most recently edited first). */
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
			const notes = await new Promise<{ id: string; body: string }[]>((resolve, reject) => {
				const transaction = db.transaction('notes', 'readonly');
				const request = transaction.objectStore('notes').getAll();
				request.addEventListener('success', () => resolve(request.result));
				request.addEventListener('error', () => reject(request.error));
			});
			return notes.sort((a, b) => (a.id < b.id ? 1 : -1));
		} finally {
			db.close();
		}
	});
}

test.describe('creating a note', () => {
	test('persists on the first character, rewrites the URL and keeps the caret', async ({
		page
	}) => {
		await page.goto('/notes/new');
		await hydration(page);

		const editor = body(page);
		await expect(editor).toBeFocused();

		// Nothing is stored while the editor is empty or only whitespace.
		await page.keyboard.type('   ');
		expect(await storedNotes(page)).toEqual([]);
		await expect(page).toHaveURL(/\/notes\/new$/);

		// The first non-whitespace character creates the note and the URL.
		await page.keyboard.type('H');
		await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}$/);
		const [note] = await storedNotes(page);
		expect(note.body).toBe('   H');

		// Same element, same focus, same caret: the URL change was a shallow
		// history update, not a navigation that remounts the editor.
		await expect(editor).toBeFocused();
		await page.keyboard.type('ello');
		await expect(editor).toHaveValue('   Hello');
	});

	test('types, waits, reloads: the content is still there', async ({ page }) => {
		await page.goto('/notes/new');
		await hydration(page);

		await page.keyboard.type('# Shopping\n- milk');

		// Wait for the save to land instead of sleeping a fixed time: the status
		// region is the component's own report that storage has the text.
		await expect(status(page)).toHaveText('Saved');
		const [note] = await storedNotes(page);
		expect(note.body).toBe('# Shopping\n- milk');

		await page.reload();
		await hydration(page);
		await expect(body(page)).toHaveValue('# Shopping\n- milk');
		await expect(status(page)).not.toHaveText('Saving…');
	});

	test('a new note left empty is never stored', async ({ page }) => {
		await page.goto('/notes/new');
		await hydration(page);

		await page.keyboard.type('   ');
		await page.goto('/');
		await hydration(page);

		expect(await storedNotes(page)).toEqual([]);
		await expect(page.getByTestId('note-list-empty')).toBeVisible();
	});
});

test.describe('autosave', () => {
	test('typing then navigating away immediately still saves', async ({ page }) => {
		// Seed through the UI so the note is real: type, let it save, then edit
		// and leave inside the debounce window.
		await page.goto('/notes/new');
		await hydration(page);
		await page.keyboard.type('first line');
		await expect(status(page)).toHaveText('Saved');

		// Inside the 500 ms window: no debounce has fired when we leave. The header
		// title is an in-app navigation at every width (the back button is
		// mobile-only), so this exercises the SvelteKit flush path everywhere.
		await page.keyboard.type(' plus more');
		await page.getByRole('heading', { level: 1 }).getByRole('link', { name: 'Notes' }).click();
		await expect(page).toHaveURL('/');

		// The row and storage both have the latest text, with nothing lost.
		await expect(async () => {
			const [note] = await storedNotes(page);
			expect(note.body).toBe('first line plus more');
		}).toPass();
	});

	/**
	 * Closing the tab is the one case where the write has to start early: an
	 * IndexedDB transaction cannot be relied on to complete after the document
	 * is gone. Browsers give us `visibilitychange → hidden` while the page is
	 * still alive, which is where the flush starts; `pagehide` then only covers
	 * the case where nothing was pending.
	 *
	 * Headless Chromium runs every page as "visible" (switching tabs does not
	 * change `document.visibilityState`), so the browser's own signal is
	 * emulated exactly as the browser delivers it: the property flips, then the
	 * event fires. What is proven is the reaction — the handler, not the browser
	 * — which is the part this code owns.
	 */
	test('a hidden tab inside the debounce window still saves', async ({ page, context }) => {
		await page.goto('/notes/new');
		await hydration(page);
		await page.keyboard.type('kept through close');
		await expect(status(page)).toHaveText('Saved');

		await page.keyboard.type(' and this too');
		await page.evaluate(() => {
			Object.defineProperty(document, 'visibilityState', {
				configurable: true,
				get: () => 'hidden'
			});
			document.dispatchEvent(new Event('visibilitychange'));
		});

		// The write had to start before the debounce: it is already stored.
		await expect(async () => {
			const [note] = await storedNotes(page);
			expect(note.body).toBe('kept through close and this too');
		}).toPass();

		// And it survives the tab actually going away.
		await page.close({ runBeforeUnload: true });
		const reopened = await context.newPage();
		await reopened.goto('/');
		await hydration(reopened);
		await expect(async () => {
			const [note] = await storedNotes(reopened);
			expect(note.body).toBe('kept through close and this too');
		}).toPass();
	});

	test('shows "Saving…" then "Saved", announced politely', async ({ page }) => {
		await page.goto('/notes/new');
		await hydration(page);

		const region = status(page);
		await expect(region).toHaveAttribute('aria-live', 'polite');

		/**
		 * Watch the region instead of polling it.
		 *
		 * "Saving…" lasts about one debounce (~500 ms) and only until the write
		 * lands, so sampling the text after the fact is a race — under load the
		 * whole state can come and go between two polls, leaving the assertion
		 * staring at "Saved" (measured: 2 failures in 6 runs on a loaded machine).
		 * A `MutationObserver` records every value the region actually showed, so
		 * the assertion is about the sequence the user sees, not about catching it
		 * in the act. It is installed before the first keystroke, so no state can
		 * be missed.
		 */
		await page.evaluate(() => {
			const region = document.querySelector('[data-testid="editor-status"]');
			if (region === null) throw new Error('the status region is not on screen');
			const seen: string[] = [(region.textContent ?? '').trim()];
			new MutationObserver(() => {
				seen.push((region.textContent ?? '').trim());
			}).observe(region, { childList: true, characterData: true, subtree: true });
			(globalThis as { statusSeen?: string[] }).statusSeen = seen;
		});

		await page.keyboard.type('status check');
		await expect(region).toHaveText('Saved');

		const seen = await page.evaluate(
			() => (globalThis as { statusSeen?: string[] }).statusSeen ?? []
		);
		// The busy state was announced…
		expect(seen).toContain('Saving…');
		// …and it came before the settled one, never after.
		expect(seen.lastIndexOf('Saving…')).toBeLessThan(seen.lastIndexOf('Saved'));
	});

	test('emptying a note and leaving deletes it', async ({ page }) => {
		await page.goto('/notes/new');
		await hydration(page);
		await page.keyboard.type('to be deleted by emptying');
		await expect(status(page)).toHaveText('Saved');
		const [created] = await storedNotes(page);

		// Select all and delete, then leave through an in-app navigation.
		await body(page).selectText();
		await page.keyboard.press('Backspace');
		await page.getByRole('heading', { level: 1 }).getByRole('link', { name: 'Notes' }).click();
		await expect(page).toHaveURL('/');

		await expect(page.getByTestId('note-list-empty')).toBeVisible();
		await expect(async () => {
			expect(await storedNotes(page)).toEqual([]);
		}).toPass();
		expect(created.id).toBeTruthy();
	});
});

test.describe('two tabs', () => {
	test('an edit in one tab appears in the other', async ({ page, context }) => {
		await page.goto('/notes/new');
		await hydration(page);
		await page.keyboard.type('shared note');
		await expect(status(page)).toHaveText('Saved');
		const url = page.url();

		// Second tab on the same note, with nothing unsaved locally.
		const other = await context.newPage();
		await other.goto(url);
		await hydration(other);
		await expect(body(other)).toHaveValue('shared note');

		// Edit in the first tab and let it save.
		await page.bringToFront();
		await page.keyboard.press('End');
		await page.keyboard.type(' edited in tab one');
		await expect(status(page)).toHaveText('Saved');

		// The other tab adopts the new body without being reloaded.
		await expect(body(other)).toHaveValue('shared note edited in tab one');
	});

	test('a note deleted in one tab tells the other, with a link back', async ({ page, context }) => {
		await page.goto('/notes/new');
		await hydration(page);
		await page.keyboard.type('doomed note');
		await expect(status(page)).toHaveText('Saved');
		const url = page.url();

		const other = await context.newPage();
		await other.goto(url);
		await hydration(other);
		await expect(body(other)).toHaveValue('doomed note');

		// Delete through storage in the first tab (the app's own delete path is
		// #8; the store's is what the other tab listens to).
		await page.evaluate(async () => {
			const open = () =>
				new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open('notes-app');
					request.addEventListener('success', () => resolve(request.result));
					request.addEventListener('error', () => reject(request.error));
				});
			const db = await open();
			const transaction = db.transaction('notes', 'readwrite');
			transaction.objectStore('notes').clear();
			await new Promise((resolve) => transaction.addEventListener('complete', resolve));
			db.close();
			// Announce it the way the repository does, so the store reacts.
			new BroadcastChannel('notes-app').postMessage({
				type: 'deleted',
				id: location.pathname.split('/').pop()
			});
		});

		await expect(other.getByTestId('editor-deleted')).toBeVisible();
		await expect(other.getByTestId('editor-deleted')).toHaveText(
			'This note was deleted in another tab'
		);
		await expect(other.getByTestId('editor-back')).toBeVisible();
	});
});

test.describe('unknown note', () => {
	test('says the note does not exist and offers the way back', async ({ page }) => {
		await page.goto('/notes/does-not-exist');
		await hydration(page);

		await expect(page.getByTestId('editor-missing')).toHaveText('This note doesn’t exist');
		await expect(page.getByTestId('editor-back')).toHaveAttribute('href', '/');
	});
});

test.describe('keyboard and layout', () => {
	test('Esc leaves the editor back to the list', async ({ page }) => {
		await page.goto('/notes/new');
		await hydration(page);
		await page.keyboard.type('typed before escape');

		await page.keyboard.press('Escape');

		// Mobile navigates back to the list; from `md` the sidebar is already
		// there, so the note stays open and the flush is what is observable.
		if ((page.viewportSize()?.width ?? 0) < 768) {
			await expect(page).toHaveURL('/');
		}
		await expect(async () => {
			const [note] = await storedNotes(page);
			expect(note.body).toBe('typed before escape');
		}).toPass();
	});

	test('Ctrl+Enter does the same, and the save lands first', async ({ page }) => {
		await page.goto('/notes/new');
		await hydration(page);
		await page.keyboard.type('typed before ctrl-enter');

		await page.keyboard.press('Control+Enter');

		if ((page.viewportSize()?.width ?? 0) < 768) {
			await expect(page).toHaveURL('/');
		}
		await expect(async () => {
			const [note] = await storedNotes(page);
			expect(note.body).toBe('typed before ctrl-enter');
		}).toPass();
	});

	test('mobile: full-screen editor, no horizontal scroll, caret line reachable', async ({
		page
	}) => {
		test.skip(!isNarrow(page), 'the single-column layout');

		await page.goto('/notes/new');
		await hydration(page);

		const editorPane = (await page.locator(EDITOR).boundingBox())!;
		const viewport = page.viewportSize()!;
		expect(editorPane.width).toBeGreaterThanOrEqual(viewport.width - 1);

		await page.keyboard.type('first line\nsecond line\nthird line');
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth
			)
		).toBeLessThanOrEqual(0);

		// The textarea fills the pane, so the caret line is inside the visible
		// area rather than below the fold of a fixed-height box.
		const box = (await body(page).boundingBox())!;
		expect(box.height).toBeGreaterThan(150);
	});

	test('desktop: the editor sits in the right pane next to the list', async ({ page }) => {
		test.skip(isNarrow(page), 'two-pane layout only');

		await page.goto('/notes/new');
		await hydration(page);

		const list = (await page.locator('[data-pane="list"]').boundingBox())!;
		const editor = (await page.locator(EDITOR).boundingBox())!;
		expect(editor.x).toBeGreaterThan(list.x + list.width - 1);
	});

	test('axe reports no serious or critical violations in the editor', async ({ page }) => {
		await page.goto('/notes/new');
		await hydration(page);
		await page.keyboard.type('# A note\nwith some body');
		await expect(status(page)).toHaveText('Saved');

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
