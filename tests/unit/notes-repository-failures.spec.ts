/**
 * Repository behaviour on the paths that corrupt or lose data if they are wrong:
 * unreadable stored records, quota exhaustion, refused opens, a schema version we
 * cannot vouch for, and migrations that must not run early.
 *
 * These live apart from `notes-repository.spec.ts` (the happy-path API suite) so
 * each file stays readable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
	createNotesRepository,
	validateNote,
	DB_NAME,
	META_STORE,
	NOTES_STORE,
	SCHEMA_VERSION_KEY,
	type NotesRepository
} from '$lib/notes/repository';
import type { NotesSync } from '$lib/notes/sync';
import {
	StorageCorruptError,
	StorageFullError,
	StorageUnavailableError,
	type Note
} from '$lib/notes/types';
import { failingFactory, failingWith } from './helpers/failing-idb';

const T0 = Date.parse('2026-10-31T13:13:00.000Z');
const ISO = (ms = T0) => new Date(ms).toISOString();

const quietSync: NotesSync = {
	post() {},
	onRemoteChange() {
		return () => {};
	},
	close() {}
};

let repository: NotesRepository | undefined;

function make(options: Parameters<typeof createNotesRepository>[0] = {}): NotesRepository {
	const repo = createNotesRepository({ sync: quietSync, ...options });
	repository = repo;
	return repo;
}

/** Opens a raw database and runs `body` against it, then closes it. */
async function withRawDb<T>(
	version: number,
	setup: (db: IDBDatabase, transaction: IDBTransaction) => void,
	body: (db: IDBDatabase) => Promise<T>
): Promise<T> {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, version);
		request.addEventListener('upgradeneeded', () => {
			const store = request.result.createObjectStore(NOTES_STORE, { keyPath: 'id' });
			store.createIndex('by-updatedAt', 'updatedAt');
			request.result.createObjectStore(META_STORE);
			if (request.transaction) setup(request.result, request.transaction);
		});
		request.addEventListener('success', () => resolve(request.result));
		request.addEventListener('error', () => reject(request.error));
	});
	try {
		return await body(db);
	} finally {
		db.close();
	}
}

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
});

afterEach(async () => {
	await repository?.close();
	repository = undefined;
});

describe('validateNote input shapes', () => {
	const valid = { id: 'a', body: 'b', createdAt: ISO(), updatedAt: ISO() };

	it('rejects values that are not objects', () => {
		for (const value of [null, undefined, 'text', 42, true]) {
			expect(validateNote(value, undefined)).toEqual({
				ok: false,
				reason: 'record is not an object'
			});
		}
	});

	it('rejects a non-string createdAt', () => {
		expect(validateNote({ ...valid, createdAt: T0 }, 'a')).toEqual({
			ok: false,
			reason: 'createdAt is not a canonical ISO 8601 UTC string'
		});
	});

	it('rejects an unparseable date', () => {
		expect(validateNote({ ...valid, updatedAt: 'not a date' }, 'a')).toEqual({
			ok: false,
			reason: 'updatedAt is not a canonical ISO 8601 UTC string'
		});
	});

	it('rejects a boolean updatedAt', () => {
		expect(validateNote({ ...valid, updatedAt: false }, 'a')).toEqual({
			ok: false,
			reason: 'updatedAt is not a canonical ISO 8601 UTC string'
		});
	});

	it('ignores a non-string key (there is nothing to compare against)', () => {
		expect(validateNote(valid, undefined)).toEqual({ ok: true, note: valid });
	});

	it('rejects a numeric id even when a key is present', () => {
		expect(validateNote({ ...valid, id: 7 }, 'a')).toEqual({
			ok: false,
			reason: 'id is not a non-empty string'
		});
	});
});

describe('quota detection', () => {
	function creatingWith(thrown: unknown): NotesRepository {
		return make({ factory: failingFactory({ methods: { add: thrown } }) });
	}

	it('maps a DOMException named QuotaExceededError', async () => {
		const repo = make({ factory: failingWith('add', 'QuotaExceededError') });

		await expect(repo.createNote('x')).rejects.toBeInstanceOf(StorageFullError);
	});

	it('maps a DOMException named NS_ERROR_DOM_QUOTA_REACHED', async () => {
		const repo = make({ factory: failingWith('add', 'NS_ERROR_DOM_QUOTA_REACHED') });

		await expect(repo.createNote('x')).rejects.toBeInstanceOf(StorageFullError);
	});

	it('detects the legacy numeric code 22', async () => {
		await expect(creatingWith({ code: 22 }).createNote('x')).rejects.toBeInstanceOf(
			StorageFullError
		);
	});

	it('detects the quota name on a plain object', async () => {
		await expect(
			creatingWith({ name: 'QuotaExceededError' }).createNote('x')
		).rejects.toBeInstanceOf(StorageFullError);
	});

	it('does not treat other failures as a full quota', async () => {
		const error = await creatingWith(new DOMException('io', 'UnknownError'))
			.createNote('x')
			.catch((thrown: unknown) => thrown);

		expect(error).not.toBeInstanceOf(StorageFullError);
		expect(error).toBeInstanceOf(StorageUnavailableError);
	});

	it('uses the error name when there is no message', async () => {
		const error = await creatingWith({ name: 'UnknownError' })
			.createNote('x')
			.catch((thrown: unknown) => thrown);

		expect((error as Error).message).toContain('UnknownError');
	});

	it('stringifies a thrown value with neither message nor name', async () => {
		const error = await creatingWith({})
			.createNote('x')
			.catch((thrown: unknown) => thrown);

		expect((error as Error).message).toContain('[object Object]');
	});
});

describe('read errors that are already typed', () => {
	it('does not double-wrap a StorageCorruptError raised while reading', async () => {
		await make({ now: () => new Date(T0) }).createNote('x');
		await repository?.close();
		const original = new StorageCorruptError('already typed');
		const repo = make({ factory: failingFactory({ methods: { getAll: original } }) });

		expect(await repo.listNotes().catch((thrown: unknown) => thrown)).toBe(original);
	});

	it('maps a failing meta read to StorageCorruptError', async () => {
		await make().listNotes();
		await repository?.close();
		const repo = make({ factory: failingWith('get', 'UnknownError', undefined, META_STORE) });

		await expect(repo.listNotes()).rejects.toBeInstanceOf(StorageCorruptError);
	});
});

describe('refused opens', () => {
	it('surfaces a synchronous throw from indexedDB.open, writing nothing', async () => {
		const repo = make({
			factory: {
				open() {
					throw new DOMException('denied', 'SecurityError');
				}
			} as unknown as IDBFactory
		});

		await expect(repo.createNote('never written')).rejects.toBeInstanceOf(StorageUnavailableError);
		expect(await indexedDB.databases()).toEqual([]);
	});

	it('close() after a failed open resolves without throwing', async () => {
		const repo = make({
			factory: {
				open() {
					throw new DOMException('denied', 'SecurityError');
				}
			} as unknown as IDBFactory
		});
		await expect(repo.listNotes()).rejects.toBeInstanceOf(StorageUnavailableError);

		await expect(repo.close()).resolves.toBeUndefined();
	});

	it('close() without an open connection is a no-op', async () => {
		await expect(make().close()).resolves.toBeUndefined();
	});
});

describe('schema version we cannot vouch for', () => {
	it('reports the stored version when it does not match', async () => {
		await withRawDb(
			1,
			(_db, transaction) => transaction.objectStore(META_STORE).put('seven', SCHEMA_VERSION_KEY),
			async () => {}
		);
		const error = await make()
			.listNotes()
			.catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(StorageCorruptError);
		expect((error as Error).message).toContain('seven');
	});

	it('opens a well-formed v1 database without recreating its stores', async () => {
		const created = await make({ now: () => new Date(T0) }).createNote('kept');
		await repository?.close();
		const repo = make();

		expect(await repo.listNotes()).toEqual([created]);
		const stores = await withRawDb(
			1,
			() => {},
			async (db) => Array.from(db.objectStoreNames)
		);
		expect(stores.sort()).toEqual([META_STORE, NOTES_STORE].sort());
	});
});

describe('a newer tab upgrades the database', () => {
	it('steps aside so the upgrade is not blocked, and never recreates the data', async () => {
		const repo = make({ now: () => new Date(T0) });
		const created = await repo.createNote('before upgrade');

		// If this connection did not yield on `versionchange`, this open would fire
		// `blocked` and hang forever.
		const upgrade = indexedDB.open(DB_NAME, 2);
		const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
			upgrade.addEventListener('success', () => resolve(upgrade.result));
			upgrade.addEventListener('error', () => reject(upgrade.error));
			upgrade.addEventListener('blocked', () => reject(new Error('blocked: we did not yield')));
		});
		expect(upgraded.version).toBe(2);
		upgraded.close();

		// This tab cannot follow another tab's bump on its own; it reports a typed
		// error instead of silently recreating or clearing anything.
		await expect(repo.getNote(created.id)).rejects.toBeInstanceOf(StorageUnavailableError);

		// The record survived the failed reopen.
		const survivor = await new Promise<unknown>((resolve, reject) => {
			const request = indexedDB.open(DB_NAME, 2);
			request.addEventListener('success', () => {
				const get = request.result
					.transaction(NOTES_STORE, 'readonly')
					.objectStore(NOTES_STORE)
					.get(created.id);
				get.addEventListener('success', () => resolve(get.result));
				get.addEventListener('error', () => reject(get.error));
			});
			request.addEventListener('error', () => reject(request.error));
		});
		expect(survivor).toEqual(created);
	});
});

describe('migrations', () => {
	it('skips migrations for versions above the one being opened', async () => {
		const ran: number[] = [];
		await make({
			schemaVersion: 2,
			migrations: [
				{ version: 3, migrate: () => ran.push(3) },
				{ version: 2, migrate: () => ran.push(2) }
			]
		}).listNotes();

		expect(ran).toEqual([2]);
	});
});

describe('restore refuses malformed input', () => {
	it('rejects a note whose id is not a string, touching nothing', async () => {
		const repo = make();
		const invalid = { id: 1, body: 'x', createdAt: ISO(), updatedAt: ISO() } as unknown as Note;

		await expect(repo.restoreNote(invalid)).rejects.toBeInstanceOf(TypeError);
		expect(await repo.listNotes()).toEqual([]);
	});
});
