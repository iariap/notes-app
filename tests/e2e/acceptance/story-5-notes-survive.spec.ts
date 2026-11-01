import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hydration, isNarrow } from '../helpers/keyboard';
import { rowTitles, rows, waitForList } from '../helpers/seed';
import { editorBody, editorStatus, sweepWidths } from './support';

/**
 * Story 5 — **Notes survive closing the browser**.
 *
 * Epic #1: "reopening shows every note intact; changes made in one tab appear in
 * other open tabs; unreadable stored data is never overwritten; stored data
 * carries a schema version for future migrations; a one-time dismissible notice
 * explains notes live only in this browser."
 *
 * ## Why this file launches its own browser
 *
 * A `page.reload()` proves nothing about this story: it keeps the same browser
 * process, the same profile directory and the same in-memory storage layer. The
 * criterion is "reopening the browser", so the test launches a **persistent
 * context** (`chromium.launchPersistentContext(userDataDir)`), creates notes
 * through the UI, **closes it**, and launches a second one on the same
 * `userDataDir`. That is a real relaunch: a new browser process, a new renderer,
 * and IndexedDB read back from disk.
 *
 * ## Why a temporary `userDataDir`
 *
 * A persistent profile is on-disk state that outlives the run. Pointing it at a
 * fixed path would make the second run of the suite fail on notes the first one
 * left behind (and would leak user data between CI jobs). `mkdtemp` gives each
 * test its own directory, removed in `finally` even when an assertion throws.
 *
 * ## Why this file skips the non-Chromium projects
 *
 * `launchPersistentContext` in this suite builds its own browser rather than
 * using the fixture, so it would run the identical Chromium path six times over.
 * The one non-Chromium engine whose storage eviction actually differs (Safari)
 * is covered by the known-limitation note in `docs/qa-v1.md`, not by pretending
 * a headless WebKit profile is iOS.
 */

const BASE_URL = `http://localhost:${Number(process.env.E2E_PORT ?? 4173)}`;

/** Creates a fresh, throwaway profile directory for one test. */
async function tempProfile(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), 'notes-app-relaunch-'));
}

/**
 * Launches a persistent Chromium context, runs `body`, and always tears the
 * context and the profile down — including when an assertion throws, so a
 * failing run does not leave a directory or a browser process behind.
 */
async function withPersistentContext(
	userDataDir: string,
	body: (context: BrowserContext) => Promise<void>
): Promise<void> {
	const context = await chromium.launchPersistentContext(userDataDir, {
		baseURL: BASE_URL,
		viewport: { width: 1280, height: 800 }
	});
	try {
		await body(context);
	} finally {
		await context.close();
	}
}

/** The first page of a fresh context, with the one-time notice already dismissed. */
async function firstPage(context: BrowserContext): Promise<Page> {
	const [page] = context.pages();
	await page.addInitScript(() => {
		window.localStorage.setItem('notes.storageNoticeDismissed', 'true');
	});
	return page;
}

test.describe('story 5 — Notes survive closing the browser', () => {
	test.beforeEach(() => {
		test.skip(
			test.info().project.name !== 'desktop',
			'launches its own Chromium context, so it would repeat the same path per project'
		);
	});

	test('AC1: notes, created dates and order survive a real browser relaunch', async () => {
		const userDataDir = await tempProfile();
		try {
			/** What the list showed at the end of the first session. */
			let before: { titles: string[]; dates: (string | null)[] } = { titles: [], dates: [] };

			// --- session one: create three notes through the UI ----------------
			await withPersistentContext(userDataDir, async (context) => {
				const page = await firstPage(context);

				/**
				 * Opens a fresh note and returns once the editor actually owns the
				 * document.
				 *
				 * Waiting on the shell alone is not enough: the shell is already
				 * mounted from the previous route, so `hydration` resolves before
				 * the new editor exists and the first keystrokes go to `<body>` —
				 * which showed up as an empty status region, not as a wrong body.
				 * Waiting for the URL *and* for the textarea to be focused asserts
				 * the state the next step depends on.
				 */
				const openNewNote = async () => {
					await page.getByRole('banner').getByRole('link', { name: 'New note' }).click();
					await expect(page).toHaveURL(/\/notes\/new$/);
					await expect(editorBody(page)).toBeFocused();
				};

				/** Leaves the editor for the list, and waits for the list to settle. */
				const leaveEditor = async () => {
					await page
						.getByRole('heading', { level: 1 })
						.getByRole('link', { name: 'Notes' })
						.click();
					await expect(page).toHaveURL('/');
					await waitForList(page);
				};

				await page.goto('/notes/new');
				await expect(editorBody(page)).toBeFocused();

				for (const text of ['First note', 'Second note', 'Third note']) {
					await page.keyboard.type(text);
					await expect(editorStatus(page)).toHaveText('Saved');
					// A fresh create per iteration, so three distinct ids and three
					// distinct created dates exist to compare after the relaunch.
					// The header title is an in-app navigation at every width; the
					// `Ctrl+Enter` shortcut only leaves the note below `md` (a known
					// limitation recorded in docs/qa-v1.md), so it is not used here.
					await leaveEditor();
					await openNewNote();
				}

				// Leave the editor the same way a user closing the app would: the
				// last note is saved and the list is what the session ends on.
				await leaveEditor();

				before = {
					titles: await rowTitles(page),
					dates: await rows(page)
						.locator('time')
						.evaluateAll((elements) => elements.map((element) => element.getAttribute('datetime')))
				};
				expect(before.titles).toEqual(['Third note', 'Second note', 'First note']);
				expect(before.dates.filter((date) => date !== null)).toHaveLength(3);
			});

			// --- session two: same profile, brand-new browser process ----------
			await withPersistentContext(userDataDir, async (context) => {
				const page = await firstPage(context);
				await page.goto('/');
				await waitForList(page);

				// Every note is back…
				expect(await rowTitles(page)).toEqual(before.titles);
				// …in the same order, which is the newest-edit-first contract…
				await expect(rows(page)).toHaveCount(3);
				// …with the same created timestamps, read back from disk.
				expect(
					await rows(page)
						.locator('time')
						.evaluateAll((elements) => elements.map((element) => element.getAttribute('datetime')))
				).toEqual(before.dates);

				// And the bodies themselves survived, not just the row projections.
				await rows(page).first().click();
				await hydration(page);
				await expect(editorBody(page)).toHaveValue('Third note');
			});
		} finally {
			await fs.rm(userDataDir, { recursive: true, force: true });
		}
	});

	test('AC2: a change made in one tab appears in the other, across a relaunch', async () => {
		const userDataDir = await tempProfile();
		try {
			await withPersistentContext(userDataDir, async (context) => {
				const page = await firstPage(context);
				await page.goto('/notes/new');
				await hydration(page);
				await page.keyboard.type('shared in two tabs');
				await expect(editorStatus(page)).toHaveText('Saved');
				const url = page.url();

				// Second tab on the same note. A separate page in the same profile
				// is a real second tab: it gets its own store and its own
				// BroadcastChannel listener.
				const other = await context.newPage();
				await other.goto(url);
				await hydration(other);
				await expect(editorBody(other)).toHaveValue('shared in two tabs');

				// Edit in the first tab; the second adopts it without a reload.
				await page.bringToFront();
				await page.keyboard.press('End');
				await page.keyboard.type(' and edited in tab one');
				await expect(editorStatus(page)).toHaveText('Saved');
				await expect(editorBody(other)).toHaveValue('shared in two tabs and edited in tab one');

				await other.close();
				await page.getByRole('heading', { level: 1 }).getByRole('link', { name: 'Notes' }).click();
				await waitForList(page);
			});

			// The cross-tab edit was durable, not just broadcast in memory.
			await withPersistentContext(userDataDir, async (context) => {
				const page = await firstPage(context);
				await page.goto('/');
				await waitForList(page);
				await expect(rows(page).first()).toContainText('shared in two tabs and edited in tab one');
			});
		} finally {
			await fs.rm(userDataDir, { recursive: true, force: true });
		}
	});

	test('AC3: unreadable stored data is reported, never overwritten', async () => {
		// The repository's invariant (never repair bytes it cannot read) is
		// proven exhaustively by `tests/unit/notes-repository*.spec.ts`, and #4's
		// spec covers the refused write. This asserts the one thing only a real
		// browser shows: the record is still byte-identical after the app has
		// opened, failed to read it, and reported the failure.
		const userDataDir = await tempProfile();
		try {
			await withPersistentContext(userDataDir, async (context) => {
				const page = await firstPage(context);
				await page.goto('/notes/new');
				await hydration(page);
				await page.keyboard.type('a note that will be corrupted');
				await expect(editorStatus(page)).toHaveText('Saved');
				await page.getByRole('heading', { level: 1 }).getByRole('link', { name: 'Notes' }).click();
				await waitForList(page);

				// Break the stored record in place — the shape a truncated write,
				// an aborted migration or a hostile extension would leave.
				const corrupted = await page.evaluate(async () => {
					const open = () =>
						new Promise<IDBDatabase>((resolve, reject) => {
							const request = indexedDB.open('notes-app');
							request.addEventListener('success', () => resolve(request.result));
							request.addEventListener('error', () => reject(request.error));
						});
					const db = await open();
					try {
						const store = db.transaction('notes', 'readwrite').objectStore('notes');
						const all = await new Promise<{ id: string }[]>((resolve, reject) => {
							const request = store.getAll();
							request.addEventListener('success', () => resolve(request.result));
							request.addEventListener('error', () => reject(request.error));
						});
						const target = all[0];
						await new Promise<void>((resolve, reject) => {
							const transaction = db.transaction('notes', 'readwrite');
							// `createdAt` no longer a canonical ISO string: unreadable.
							transaction.objectStore('notes').put({
								id: target.id,
								body: 'a note that will be corrupted',
								createdAt: 'not-a-date',
								updatedAt: '2026-10-31T00:00:00.000Z'
							});
							transaction.addEventListener('complete', () => resolve());
							transaction.addEventListener('error', () => reject(transaction.error));
						});
						return target.id;
					} finally {
						db.close();
					}
				});

				// Reload: the app opens the database, refuses the bad record, and the
				// list stays usable instead of being replaced by a broken state.
				await page.reload();
				await waitForList(page);

				// The bytes are exactly what was written — no silent repair.
				const stored = await page.evaluate(async (id) => {
					const open = () =>
						new Promise<IDBDatabase>((resolve, reject) => {
							const request = indexedDB.open('notes-app');
							request.addEventListener('success', () => resolve(request.result));
							request.addEventListener('error', () => reject(request.error));
						});
					const db = await open();
					try {
						return await new Promise<unknown>((resolve, reject) => {
							const request = db.transaction('notes', 'readonly').objectStore('notes').get(id);
							request.addEventListener('success', () => resolve(request.result));
							request.addEventListener('error', () => reject(request.error));
						});
					} finally {
						db.close();
					}
				}, corrupted);
				expect(stored).toEqual({
					id: corrupted,
					body: 'a note that will be corrupted',
					createdAt: 'not-a-date',
					updatedAt: '2026-10-31T00:00:00.000Z'
				});
			});
		} finally {
			await fs.rm(userDataDir, { recursive: true, force: true });
		}
	});

	test('AC4: stored data carries a schema version', async ({ page }) => {
		// The `meta` record is what the repository checks on every open, and a
		// mismatch is refused rather than migrated blindly. Only a real browser
		// can show the record's actual stored shape.
		await page.goto('/');
		await waitForList(page);

		const meta = await page.evaluate(async () => {
			const open = () =>
				new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open('notes-app');
					request.addEventListener('success', () => resolve(request.result));
					request.addEventListener('error', () => reject(request.error));
				});
			const db = await open();
			try {
				const version = await new Promise<unknown>((resolve, reject) => {
					const request = db
						.transaction('meta', 'readonly')
						.objectStore('meta')
						.get('schemaVersion');
					request.addEventListener('success', () => resolve(request.result));
					request.addEventListener('error', () => reject(request.error));
				});
				return { version, stores: [...db.objectStoreNames] };
			} finally {
				db.close();
			}
		});

		expect(meta.version).toBe(1);
		// The stores a migration can rely on.
		expect(meta.stores).toEqual(expect.arrayContaining(['notes', 'meta']));
	});

	test('AC5: the one-time notice explains where notes live, and is dismissible', async ({
		page
	}) => {
		// #10's `storage-notice.spec.ts` proves the copy, the dismissal and its
		// persistence at every width. This asserts the acceptance criterion as the
		// epic words it: the notice exists, says notes live in this browser, and
		// does not come back.
		await page.goto('/');

		const notice = page.getByTestId('storage-notice');
		await expect(notice).toBeVisible();
		await expect(notice).toContainText('stored only in this browser');

		await page.getByRole('button', { name: 'OK, got it' }).click();
		await expect(notice).toHaveCount(0);
		await page.reload();
		await expect(page.getByRole('heading', { level: 1, name: 'Notes' })).toBeVisible();
		await expect(notice).toHaveCount(0);
	});

	test('AC6: no horizontal overflow with the notice up, at 320 through 1920 px', async ({
		page
	}, testInfo) => {
		await page.goto('/');
		await expect(page.getByTestId('storage-notice')).toBeVisible();

		await sweepWidths(page, testInfo, 'story-5 storage notice');
	});

	test('AC7: the single-column layout is what a phone gets after a relaunch', async ({ page }) => {
		// The relaunch tests above run at 1280 px. This one pins the layout
		// contract for a phone-sized profile, where the editor takes the whole
		// column and the back affordance is the way out.
		await page.setViewportSize({ width: 375, height: 667 });
		await page.goto('/notes/new');
		await hydration(page);
		await page.keyboard.type('phone note');
		await expect(editorStatus(page)).toHaveText('Saved');

		await page.reload();
		await hydration(page);
		// A reload is weaker than a relaunch (session one covers that), so this
		// asserts the layout, not persistence.
		await expect(editorBody(page)).toHaveValue('phone note');

		const editorPane = (await page.locator('[data-pane="editor"]').boundingBox())!;
		expect(editorPane.width).toBeGreaterThanOrEqual(375 - 1);
		expect(isNarrow(page)).toBe(true);
	});
});
