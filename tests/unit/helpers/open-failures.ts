/**
 * Test-only `IDBFactory` stubs for open failures, built on *native* failure
 * paths rather than synthetic events, so what the repository sees is exactly
 * what a browser would produce.
 *
 * Three shapes:
 * - `open()` throws synchronously (storage access denied outright).
 * - opening a lower version than the stored one fails with `VersionError`.
 * - another connection holds an older version open, so the open is `blocked`.
 */
import { IDBFactory } from 'fake-indexeddb';

/** `open()` throws synchronously, as it does when storage access is denied. */
export function throwingOpenFactory(errorName = 'SecurityError'): IDBFactory & { calls: number } {
	const factory = {
		calls: 0,
		open(): IDBOpenDBRequest {
			factory.calls += 1;
			throw new DOMException('storage access denied', errorName);
		}
	};
	return factory as unknown as IDBFactory & { calls: number };
}

/** Opens a raw database on a private factory, creating one store and one record. */
async function seedDatabase(
	factory: IDBFactory,
	name: string,
	version: number
): Promise<{ close(): void }> {
	const request = factory.open(name, version);
	request.addEventListener('upgradeneeded', () => {
		const store = request.result.createObjectStore('existing', { keyPath: 'id' });
		store.put({ id: 'keep-me', body: 'user data' });
	});
	await new Promise<void>((resolve, reject) => {
		request.addEventListener('success', () => resolve());
		request.addEventListener('error', () => reject(request.error));
	});
	return { close: () => request.result.close() };
}

/**
 * A factory whose database already exists at `storedVersion`, holding a record
 * in an `existing` store. Opening at any lower version fails with
 * `VersionError` — a real "this browser cannot open the DB" path.
 */
export function versionConflictFactory(
	storedVersion = 5,
	dbName = 'notes-app'
): {
	factory: IDBFactory;
	calls: number;
	inspect(): Promise<{ stores: string[]; records: unknown[] }>;
	dispose(): Promise<void>;
} {
	const inner = new IDBFactory();
	const state = { calls: 0, seeded: false };
	const factory = {
		open(name: string, version?: number): IDBOpenDBRequest {
			state.calls += 1;
			return inner.open(name, version);
		}
	} as unknown as IDBFactory;

	return {
		factory,
		get calls() {
			return state.calls;
		},
		async inspect() {
			if (!state.seeded) {
				await seedDatabase(inner, dbName, storedVersion);
				state.seeded = true;
			}
			const request = inner.open(dbName);
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				request.addEventListener('success', () => resolve(request.result));
				request.addEventListener('error', () => reject(request.error));
			});
			const stores = Array.from(db.objectStoreNames);
			const records: unknown[] = [];
			if (stores.includes('existing')) {
				const transaction = db.transaction('existing', 'readonly');
				const getAll = transaction.objectStore('existing').getAll();
				records.push(
					...((await new Promise<unknown[]>((resolve, reject) => {
						getAll.addEventListener('success', () => resolve(getAll.result as unknown[]));
						getAll.addEventListener('error', () => reject(getAll.error));
					})) as unknown[])
				);
			}
			db.close();
			return { stores, records };
		},
		async dispose() {
			const request = inner.deleteDatabase(dbName);
			await new Promise<void>((resolve) => {
				request.addEventListener('success', () => resolve());
				request.addEventListener('error', () => resolve());
				request.addEventListener('blocked', () => resolve());
			});
		}
	};
}

/**
 * A factory with an older version still open by another connection, so a
 * version-upgrade open is `blocked` (what a second tab experiences mid-upgrade).
 */
export function blockedOpenFactory(dbName = 'notes-app'): {
	factory: IDBFactory;
	release(): void;
} {
	const inner = new IDBFactory();
	const factory = {
		open(name: string, version?: number): IDBOpenDBRequest {
			return inner.open(name, version);
		}
	} as unknown as IDBFactory;

	const request = inner.open(dbName, 1);
	request.addEventListener('upgradeneeded', () => {
		request.result.createObjectStore('notes', { keyPath: 'id' });
	});
	return {
		factory,
		release() {
			request.result?.close();
		}
	};
}
