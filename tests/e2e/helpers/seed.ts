import type { Page } from '@playwright/test';

/**
 * Seeds notes straight into the app's IndexedDB.
 *
 * The app is a client-only SPA whose whole state is storage, so E2E tests must
 * write the same records the repository writes rather than driving the UI to
 * create them (#7 owns creating notes through the editor).
 *
 * The database is opened at whatever version the app already created — the
 * script never creates or upgrades the schema, so a mismatch shows up as a real
 * failure instead of silently forking the shape.
 */
export interface SeedNote {
	id: string;
	body: string;
	createdAt: string;
	updatedAt: string;
}

/** Database and store names, mirrored from `src/lib/notes/repository.ts`. */
export const DB_NAME = 'notes-app';
export const NOTES_STORE = 'notes';

/** A note record that satisfies the repository's validation. */
export function seedNote(
	index: number,
	body: string,
	createdAt: string,
	updatedAt: string = createdAt
): SeedNote {
	return { id: `seeded-${String(index).padStart(4, '0')}`, body, createdAt, updatedAt };
}

/**
 * Makes storage hold exactly `notes`, then reloads so the app's first read
 * includes them.
 *
 * It **replaces** the stored set (records not in `notes` are deleted) rather
 * than appending: every test seeds the state it wants to assert on, and a
 * leftover note from an earlier call in the same page would make the assertions
 * depend on test order. Deleting rows directly is a test-fixture concern only —
 * the app itself never removes notes without an explicit user action (#8).
 *
 * The first `goto` lets the app create the schema and the `meta` record; seeding
 * into a database that does not exist yet would produce a shape the repository
 * refuses to open (correctly — it never repairs storage it cannot vouch for).
 *
 * Returns the seeded records, so callers can build URLs from the same ids.
 */
export async function seedNotes(
	page: Page,
	notes: readonly SeedNote[]
): Promise<readonly SeedNote[]> {
	// Waiting for the shell is not enough: the database is created by the store's
	// first read, which is still in flight at that point. Opening the database
	// ourselves before that read resolves would create it *without* the `notes`
	// store, which the app would then (correctly) refuse to read. Waiting for the
	// list's settled state proves the app's own open finished.
	await page.goto('/');
	await waitForList(page);

	await page.evaluate(
		async ({ dbName, storeName, records }) => {
			const open = () =>
				new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open(dbName);
					request.addEventListener('success', () => resolve(request.result));
					request.addEventListener('error', () => reject(request.error));
				});

			const db = await open();
			try {
				await new Promise<void>((resolve, reject) => {
					const transaction = db.transaction(storeName, 'readwrite');
					const store = transaction.objectStore(storeName);
					store.clear();
					for (const record of records) store.put(record);
					transaction.addEventListener('complete', () => resolve());
					transaction.addEventListener('error', () => reject(transaction.error));
					transaction.addEventListener('abort', () =>
						reject(transaction.error ?? new Error('seed transaction aborted'))
					);
				});
			} finally {
				db.close();
			}
		},
		{ dbName: DB_NAME, storeName: NOTES_STORE, records: notes }
	);

	await page.reload();
	return notes;
}

/** Waits until the list has settled into one of its non-loading states. */
export async function waitForList(page: Page): Promise<void> {
	await page.waitForFunction(() => {
		const list = document.querySelector('[data-slot="note-list"]');
		if (!list) return false;
		return (
			list.querySelector('[data-testid="note-list-items"]') !== null ||
			list.querySelector('[data-testid="note-list-empty"]') !== null ||
			list.querySelector('[data-testid="note-list-error"]') !== null
		);
	});
}

/** Rows in DOM order, as rendered. */
export function rows(page: Page) {
	return page.locator('[data-slot="note-row"]');
}

/**
 * The title of every row, in DOM order.
 *
 * `rows(page).locator('span').first()` would be a bug: `.first()` picks the
 * first match across *all* rows, not the first span of each one.
 */
export async function rowTitles(page: Page): Promise<string[]> {
	return rows(page).evaluateAll((elements) =>
		elements.map((element) => element.querySelector('span')?.textContent?.trim() ?? '')
	);
}
