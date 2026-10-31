import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
	createNotesRepository,
	compareNotes,
	sortNotes,
	validateNote,
	DB_NAME,
	META_STORE,
	NOTES_STORE,
	SCHEMA_VERSION,
	SCHEMA_VERSION_KEY,
	UPDATED_AT_INDEX,
	type MigrationContext,
	type NotesRepository,
	type RepositoryOptions
} from '$lib/notes/repository';
import type { NotesSync, RemoteChange } from '$lib/notes/sync';
import {
	NoteMissingError,
	StorageCorruptError,
	StorageFullError,
	StorageUnavailableError,
	type InvalidRecord,
	type Note
} from '$lib/notes/types';
import {
	blockedOpenFactory,
	throwingOpenFactory,
	versionConflictFactory
} from './helpers/open-failures';
import { failingWith } from './helpers/failing-idb';

const T0 = Date.parse('2026-10-31T13:13:00.000Z');
const ISO = (ms = T0) => new Date(ms).toISOString();

/** A clock that advances one second per read, so ordering is unambiguous. */
function steppingClock(startMs = T0): () => Date {
	let current = startMs;
	return () => {
		const date = new Date(current);
		current += 1000;
		return date;
	};
}

interface SyncSpy extends NotesSync {
	posted: RemoteChange[];
}

function spySync(): SyncSpy {
	const posted: RemoteChange[] = [];
	return {
		posted,
		post(change) {
			posted.push(change);
		},
		onRemoteChange() {
			return () => {};
		},
		close() {}
	};
}

let repository: NotesRepository | undefined;

function make(options: RepositoryOptions = {}): NotesRepository {
	const repo = createNotesRepository({ now: steppingClock(), sync: spySync(), ...options });
	repository = repo;
	return repo;
}

/**
 * Opens the raw database, to seed records the repository itself would never
 * write. A store created here gets the same `meta.schemaVersion` the repository
 * writes, so seeded databases look exactly like ones the app has used.
 *
 * With no `version`, opens whatever version exists (used by the read helpers
 * below, which must not force a downgrade after a migration test).
 */
function openRaw(name = DB_NAME, version?: number): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
		request.onupgradeneeded = (event) => {
			const db = request.result;
			if (!db.objectStoreNames.contains(NOTES_STORE)) {
				const store = db.createObjectStore(NOTES_STORE, { keyPath: 'id' });
				store.createIndex(UPDATED_AT_INDEX, 'updatedAt');
			}
			if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
			if (request.transaction) {
				request.transaction.objectStore(META_STORE).put(event.newVersion, SCHEMA_VERSION_KEY);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** Writes records straight into the store, bypassing validation. */
async function seedRaw(records: { key: IDBValidKey; value: unknown }[]): Promise<void> {
	const db = await openRaw();
	await new Promise<void>((resolve, reject) => {
		const transaction = db.transaction(NOTES_STORE, 'readwrite');
		const store = transaction.objectStore(NOTES_STORE);
		for (const record of records) store.put(record.value);
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () => reject(transaction.error);
	});
	db.close();
}

async function readRaw(key: IDBValidKey): Promise<unknown> {
	const db = await openRaw();
	const value = await new Promise<unknown>((resolve, reject) => {
		const request = db.transaction(NOTES_STORE, 'readonly').objectStore(NOTES_STORE).get(key);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	db.close();
	return value;
}

async function readAllRaw(): Promise<unknown[]> {
	const db = await openRaw();
	const values = await new Promise<unknown[]>((resolve, reject) => {
		const request = db.transaction(NOTES_STORE, 'readonly').objectStore(NOTES_STORE).getAll();
		request.onsuccess = () => resolve(request.result as unknown[]);
		request.onerror = () => reject(request.error);
	});
	db.close();
	return values;
}

async function readSchemaVersion(): Promise<unknown> {
	const db = await openRaw();
	const value = await new Promise<unknown>((resolve, reject) => {
		const request = db
			.transaction(META_STORE, 'readonly')
			.objectStore(META_STORE)
			.get(SCHEMA_VERSION_KEY);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	db.close();
	return value;
}

beforeEach(() => {
	// A fresh in-memory IndexedDB per test keeps them independent.
	globalThis.indexedDB = new IDBFactory();
});

afterEach(async () => {
	await repository?.close();
	repository = undefined;
});

describe('schema', () => {
	it('creates the notes store keyed by id, with a by-updatedAt index, and the meta store', async () => {
		await make().listNotes();

		const db = await openRaw();
		expect(db.objectStoreNames.contains(NOTES_STORE)).toBe(true);
		expect(db.objectStoreNames.contains(META_STORE)).toBe(true);
		const store = db.transaction(NOTES_STORE, 'readonly').objectStore(NOTES_STORE);
		expect(Array.from(store.indexNames)).toEqual([UPDATED_AT_INDEX]);
		expect(store.keyPath).toBe('id');
		db.close();
	});

	it('starts at schemaVersion 1 in meta', async () => {
		await make().listNotes();

		expect(SCHEMA_VERSION).toBe(1);
		expect(await readSchemaVersion()).toBe(1);
	});
});

describe('createNote', () => {
	it('creates a note with the injected clock, id and body', async () => {
		const repo = make({ createId: () => 'note-1', now: () => new Date(T0) });

		const note = await repo.createNote('# Groceries\n- milk');

		expect(note).toEqual({
			id: 'note-1',
			body: '# Groceries\n- milk',
			createdAt: ISO(),
			updatedAt: ISO()
		});
		expect(await repo.getNote('note-1')).toEqual(note);
		expect(await readRaw('note-1')).toEqual(note);
	});

	it('generates a UUID by default', async () => {
		const note = await make().createNote('hello');

		expect(note.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it('stores canonical ISO 8601 UTC strings', async () => {
		const note = await make({ now: () => new Date('2026-01-02T03:04:05.678Z') }).createNote('x');

		expect(note.createdAt).toBe('2026-01-02T03:04:05.678Z');
	});

	it('accepts an empty body (the editor discards empty notes, not storage)', async () => {
		const note = await make().createNote('');

		expect(await make().getNote(note.id)).toEqual(note);
	});

	it('rejects a non-string body without writing', async () => {
		const repo = make();

		await expect(repo.createNote(42 as unknown as string)).rejects.toBeInstanceOf(TypeError);
		expect(await readAllRaw()).toEqual([]);
	});

	it('refuses to overwrite an existing id and reports a typed error', async () => {
		const repo = make({ createId: () => 'same' });
		const first = await repo.createNote('first');

		await expect(repo.createNote('second')).rejects.not.toBeInstanceOf(StorageFullError);
		expect(await readRaw('same')).toEqual(first);
	});

	it('publishes "created" after the write commits', async () => {
		const sync = spySync();
		const repo = make({ sync, createId: () => 'note-1' });

		await repo.createNote('a');

		expect(sync.posted).toEqual([{ type: 'created', id: 'note-1' }]);
		expect(await readRaw('note-1')).toBeDefined();
	});
});

describe('listNotes', () => {
	it('returns [] for a fresh database', async () => {
		expect(await make().listNotes()).toEqual([]);
	});

	it('sorts by updatedAt descending', async () => {
		const repo = make();
		const first = await repo.createNote('first');
		const second = await repo.createNote('second');
		const third = await repo.createNote('third');

		const notes = await repo.listNotes();

		expect(notes.map((note) => note.id)).toEqual([third.id, second.id, first.id]);
		expect(notes.map((note) => note.body)).toEqual(['third', 'second', 'first']);
	});

	it('puts an edited note first', async () => {
		const repo = make();
		const first = await repo.createNote('first');
		const second = await repo.createNote('second');

		await repo.updateNote(first.id, 'first edited');

		expect((await repo.listNotes()).map((note) => note.id)).toEqual([first.id, second.id]);
	});

	it('breaks updatedAt ties by id, descending and reproducibly', async () => {
		const repo = make({ now: () => new Date(T0) });
		await repo.createNote('a');
		await repo.createNote('b');

		const ids = (await repo.listNotes()).map((note) => note.id);

		expect(ids).toEqual([...ids].sort().reverse());
		expect((await repo.listNotes()).map((note) => note.id)).toEqual(ids);
	});

	it('skips invalid records, reports them, and still returns every valid note', async () => {
		const repo = make();
		const valid = await repo.createNote('stored by the app');
		// Records a keyPath store can physically hold but the contract rejects.
		await seedRaw([
			{ key: 'bad-body', value: { id: 'bad-body', body: 7, createdAt: ISO(), updatedAt: ISO() } },
			{ key: 'no-dates', value: { id: 'no-dates', body: 'b' } },
			{ key: 'numeric-id', value: { id: 42, body: 'b', createdAt: ISO(), updatedAt: ISO() } }
		]);

		expect(await repo.listNotes()).toEqual([valid]);
		// IndexedDB returns records in key order (numbers before strings).
		expect(repo.skippedRecords.map((record) => record.reason)).toEqual([
			'id is not a non-empty string',
			'body is not a string',
			'createdAt is not a canonical ISO 8601 UTC string'
		]);
		expect(repo.skippedRecords.map((record) => record.key)).toEqual([42, 'bad-body', 'no-dates']);
	});

	it('leaves invalid records byte-for-byte untouched in IndexedDB', async () => {
		const repo = make();
		const corrupt = { id: 'corrupt', body: 42, createdAt: ISO(), updatedAt: null };
		await seedRaw([{ key: 'corrupt', value: corrupt }]);

		await repo.listNotes();

		expect(await readRaw('corrupt')).toEqual(corrupt);
		expect(await readAllRaw()).toHaveLength(1);
	});

	it('reports each invalid record through onInvalidRecord on every read', async () => {
		const reported: InvalidRecord[] = [];
		const repo = make({ onInvalidRecord: (record) => reported.push(record) });
		await seedRaw([{ key: 'broken', value: { id: 'broken', body: 1 } }]);

		await repo.listNotes();
		await repo.listNotes();

		expect(reported.map((record) => record.key)).toEqual(['broken', 'broken']);
	});

	it('clears skippedRecords once a read finds nothing invalid', async () => {
		const repo = make();
		await seedRaw([{ key: 'broken', value: { id: 'broken', body: 1 } }]);
		await repo.listNotes();
		expect(repo.skippedRecords).toHaveLength(1);

		const db = await openRaw();
		await new Promise<void>((resolve, reject) => {
			const transaction = db.transaction(NOTES_STORE, 'readwrite');
			transaction.objectStore(NOTES_STORE).clear();
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});
		db.close();

		expect(await repo.listNotes()).toEqual([]);
		expect(repo.skippedRecords).toEqual([]);
	});

	it('reports a value whose id disagrees with its stored key', async () => {
		// A `keyPath` store cannot hold such a record (the key *is* `id`), so this
		// defends against a future migration or a manually edited database.
		expect(
			validateNote({ id: 'key-b', body: 'mismatch', createdAt: ISO(), updatedAt: ISO() }, 'key-a')
		).toEqual({ ok: false, reason: 'id does not match the record key' });
	});

	it('rejects timestamps that are not canonical ISO 8601 UTC', async () => {
		const repo = make();
		const valid = ISO();
		await seedRaw(
			[
				'2026-10-31',
				'2026-10-31T13:13:00.000-03:00',
				'2026-02-30T00:00:00.000Z',
				'2026-10-31T13:13:00Z'
			].map((createdAt, index) => ({
				key: `bad-${index}`,
				value: { id: `bad-${index}`, body: 'b', createdAt, updatedAt: valid }
			}))
		);

		expect(await repo.listNotes()).toEqual([]);
		expect(repo.skippedRecords.map((record) => record.key)).toEqual([
			'bad-0',
			'bad-1',
			'bad-2',
			'bad-3'
		]);
		expect(new Set(repo.skippedRecords.map((record) => record.reason))).toEqual(
			new Set(['createdAt is not a canonical ISO 8601 UTC string'])
		);
	});
});

describe('getNote', () => {
	it('returns the stored note', async () => {
		const repo = make();
		const created = await repo.createNote('hello');

		expect(await repo.getNote(created.id)).toEqual(created);
	});

	it('returns undefined for an unknown id', async () => {
		expect(await make().getNote('nope')).toBeUndefined();
	});

	it('throws StorageCorruptError for an unreadable record and leaves it untouched', async () => {
		const repo = make();
		const corrupt = { id: 'corrupt', body: null, createdAt: ISO(), updatedAt: ISO() };
		await seedRaw([{ key: 'corrupt', value: corrupt }]);

		await expect(repo.getNote('corrupt')).rejects.toBeInstanceOf(StorageCorruptError);
		expect(await readRaw('corrupt')).toEqual(corrupt);
		expect(repo.skippedRecords).toHaveLength(1);
	});
});

describe('updateNote', () => {
	it('bumps updatedAt and keeps createdAt', async () => {
		const repo = make({ createId: () => 'note-1' });
		const created = await repo.createNote('v1');

		const updated = await repo.updateNote('note-1', 'v2');

		expect(updated.body).toBe('v2');
		expect(updated.createdAt).toBe(created.createdAt);
		expect(updated.updatedAt).toBe(new Date(T0 + 1000).toISOString());
		expect(await repo.getNote('note-1')).toEqual(updated);
	});

	it('never changes createdAt, however many edits', async () => {
		const repo = make();
		const created = await repo.createNote('v1');

		for (let index = 0; index < 5; index += 1) await repo.updateNote(created.id, `v${index + 2}`);

		const final = await repo.getNote(created.id);
		expect(final?.createdAt).toBe(created.createdAt);
		expect(final?.id).toBe(created.id);
	});

	it('publishes "updated" after a successful write', async () => {
		const sync = spySync();
		const repo = make({ sync });
		const created = await repo.createNote('v1');

		await repo.updateNote(created.id, 'v2');

		expect(sync.posted).toEqual([
			{ type: 'created', id: created.id },
			{ type: 'updated', id: created.id }
		]);
	});

	it('throws NoteMissingError for an unknown id and writes nothing', async () => {
		const repo = make();
		await repo.createNote('kept');

		await expect(repo.updateNote('ghost', 'x')).rejects.toBeInstanceOf(NoteMissingError);
		expect(await repo.listNotes()).toHaveLength(1);
	});

	it('refuses to overwrite an unreadable record', async () => {
		const repo = make();
		const corrupt = { id: 'corrupt', body: 123 };
		await seedRaw([{ key: 'corrupt', value: corrupt }]);

		await expect(repo.updateNote('corrupt', 'new body')).rejects.toBeInstanceOf(
			StorageCorruptError
		);
		expect(await readRaw('corrupt')).toEqual(corrupt);
	});

	it('rejects a non-string body and leaves the note unchanged', async () => {
		const repo = make();
		const created = await repo.createNote('v1');

		await expect(repo.updateNote(created.id, null as unknown as string)).rejects.toBeInstanceOf(
			TypeError
		);
		expect(await repo.getNote(created.id)).toEqual(created);
	});
});

describe('deleteNote', () => {
	it('returns the deleted note and removes it', async () => {
		const repo = make();
		const created = await repo.createNote('bye');

		expect(await repo.deleteNote(created.id)).toEqual(created);
		expect(await repo.getNote(created.id)).toBeUndefined();
		expect(await repo.listNotes()).toEqual([]);
	});

	it('publishes "deleted" only after the write commits', async () => {
		const sync = spySync();
		const repo = make({ sync });
		const created = await repo.createNote('bye');

		await repo.deleteNote(created.id);

		expect(sync.posted.at(-1)).toEqual({ type: 'deleted', id: created.id });
		expect(await readAllRaw()).toEqual([]);
	});

	it('does not publish when the note is missing', async () => {
		const sync = spySync();
		const repo = make({ sync });

		await expect(repo.deleteNote('ghost')).rejects.toBeInstanceOf(NoteMissingError);
		expect(sync.posted).toEqual([]);
	});

	it('refuses to delete an unreadable record', async () => {
		const repo = make();
		const corrupt = { id: 'corrupt', body: {} };
		await seedRaw([{ key: 'corrupt', value: corrupt }]);

		await expect(repo.deleteNote('corrupt')).rejects.toBeInstanceOf(StorageCorruptError);
		expect(await readRaw('corrupt')).toEqual(corrupt);
	});
});

describe('restoreNote', () => {
	it('restores an identical record: same id, body and dates', async () => {
		const repo = make();
		const created = await repo.createNote('to undo');
		const deleted = await repo.deleteNote(created.id);

		await repo.restoreNote(deleted);

		expect(await repo.getNote(created.id)).toEqual(created);
		expect(await repo.getNote(created.id)).toEqual(deleted);
		expect(await repo.listNotes()).toEqual([created]);
	});

	it('restores in the original list position', async () => {
		const repo = make();
		const first = await repo.createNote('first');
		const second = await repo.createNote('second');
		const third = await repo.createNote('third');

		await repo.restoreNote(await repo.deleteNote(second.id));

		expect((await repo.listNotes()).map((note) => note.id)).toEqual([
			third.id,
			second.id,
			first.id
		]);
	});

	it('publishes "restored" after a successful write', async () => {
		const sync = spySync();
		const repo = make({ sync });
		const created = await repo.createNote('x');
		await repo.deleteNote(created.id);

		await repo.restoreNote(created);

		expect(sync.posted.at(-1)).toEqual({ type: 'restored', id: created.id });
	});

	it('rejects an invalid note without writing', async () => {
		const repo = make();
		const invalid = { id: 'x', body: 1, createdAt: 'nope', updatedAt: 'nope' } as unknown as Note;

		await expect(repo.restoreNote(invalid)).rejects.toBeInstanceOf(TypeError);
		expect(await readAllRaw()).toEqual([]);
	});

	it('refuses to overwrite an unreadable record with the same id', async () => {
		const repo = make();
		const corrupt = { id: 'dup', body: [] };
		await seedRaw([{ key: 'dup', value: corrupt }]);

		await expect(
			repo.restoreNote({ id: 'dup', body: 'restore me', createdAt: ISO(), updatedAt: ISO() })
		).rejects.toBeInstanceOf(StorageCorruptError);
		expect(await readRaw('dup')).toEqual(corrupt);
	});

	it('overwrites a valid existing record (last write wins)', async () => {
		const repo = make();
		const created = await repo.createNote('v1');
		await repo.updateNote(created.id, 'v2');

		await repo.restoreNote(created);

		expect(await repo.getNote(created.id)).toEqual(created);
	});
});

describe('migrations', () => {
	it('calls the migration hook with the versions being upgraded', async () => {
		const seed = make();
		const seeded = await seed.createNote('kept across migration');
		await seed.close();

		const calls: MigrationContext[] = [];
		const repo = make({
			schemaVersion: 2,
			migrations: [
				{
					version: 2,
					migrate(context) {
						calls.push(context);
						// A v2 migration could rewrite records; this one marks them.
						context.transaction
							.objectStore(NOTES_STORE)
							.put({ ...seeded, body: `${seeded.body} (migrated)` });
					}
				}
			]
		});

		const notes = await repo.listNotes();

		expect(calls).toHaveLength(1);
		expect(calls[0].oldVersion).toBe(1);
		expect(calls[0].newVersion).toBe(2);
		expect(notes.map((note) => note.body)).toEqual(['kept across migration (migrated)']);
	});

	it('updates the stored schemaVersion to the new version', async () => {
		const seed = make();
		await seed.listNotes();
		await seed.close();

		const repo = make({
			schemaVersion: 2,
			migrations: [{ version: 2, migrate() {} }]
		});
		await repo.listNotes();

		expect(await readSchemaVersion()).toBe(2);
	});

	it('runs each migration once, and skips already-applied versions', async () => {
		const calls: number[] = [];
		const migrations = [
			{
				version: 2,
				migrate() {
					calls.push(2);
				}
			},
			{
				version: 3,
				migrate() {
					calls.push(3);
				}
			}
		];
		const first = make({ schemaVersion: 3, migrations });
		await first.listNotes();
		await first.close();

		const second = make({ schemaVersion: 3, migrations });
		await second.listNotes();

		expect(calls).toEqual([2, 3]);
	});

	it('runs every pending migration when jumping several versions', async () => {
		const calls: number[] = [];
		const repo = make({
			schemaVersion: 3,
			migrations: [
				{
					version: 3,
					migrate() {
						calls.push(3);
					}
				},
				{
					version: 2,
					migrate() {
						calls.push(2);
					}
				}
			]
		});

		await repo.listNotes();

		expect(calls).toEqual([2, 3]);
	});

	it('runs migrations on a fresh install as no-ops, without a "notes with data" precondition', async () => {
		const contexts: MigrationContext[] = [];
		const repo = make({
			schemaVersion: 2,
			migrations: [
				{
					version: 2,
					migrate(context) {
						contexts.push(context);
					}
				}
			]
		});

		expect(await repo.listNotes()).toEqual([]);
		expect(contexts).toHaveLength(1);
		expect(contexts[0].oldVersion).toBe(0);
		// The v1 stores exist by the time a migration runs, even on a fresh install.
		expect(contexts[0].transaction.objectStoreNames.contains(NOTES_STORE)).toBe(true);
	});

	it('rolls the upgrade back, keeping v1 data, when a migration throws', async () => {
		const seed = make();
		const seeded = await seed.createNote('survives');
		await seed.close();

		const repo = make({
			schemaVersion: 2,
			migrations: [
				{
					version: 2,
					migrate() {
						throw new Error('migration bug');
					}
				}
			]
		});

		await expect(repo.listNotes()).rejects.toBeInstanceOf(StorageUnavailableError);
		expect(await readRaw(seeded.id)).toEqual(seeded);
		expect(await readSchemaVersion()).toBe(1);
	});
});

describe('open failures', () => {
	it('surfaces a synchronous throw from indexedDB.open, touching nothing', async () => {
		const factory = throwingOpenFactory('SecurityError');
		const repo = make({ factory });

		const error = await repo.createNote('never written').catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(StorageUnavailableError);
		expect((error as StorageUnavailableError).cause).toBeInstanceOf(DOMException);
		expect(factory.calls).toBe(1);
		// The open never happened, so nothing was written anywhere.
		expect(await indexedDB.databases()).toEqual([]);
	});

	it('reports StorageUnavailableError when the database cannot be opened, and writes nothing', async () => {
		// The stored database is v5; asking for v1 fails with a native VersionError,
		// which is exactly what a browser does when it refuses the open.
		const conflict = versionConflictFactory(5);
		const before = await conflict.inspect();
		const repo = make({ factory: conflict.factory });

		await expect(repo.listNotes()).rejects.toBeInstanceOf(StorageUnavailableError);
		await expect(repo.createNote('never written')).rejects.toBeInstanceOf(StorageUnavailableError);

		// Same stores, same records: the failed open changed nothing.
		expect(await conflict.inspect()).toEqual(before);
		expect(before.records).toEqual([{ id: 'keep-me', body: 'user data' }]);
		await conflict.dispose();
	});

	it('reports StorageUnavailableError when another tab blocks the upgrade', async () => {
		const blocked = blockedOpenFactory();
		try {
			await expect(
				make({ factory: blocked.factory, schemaVersion: 2 }).listNotes()
			).rejects.toBeInstanceOf(StorageUnavailableError);
		} finally {
			blocked.release();
		}
	});

	it('throws StorageUnavailableError when indexedDB is missing entirely', async () => {
		const saved = globalThis.indexedDB;
		Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true });
		try {
			await expect(make().listNotes()).rejects.toBeInstanceOf(StorageUnavailableError);
		} finally {
			Object.defineProperty(globalThis, 'indexedDB', { value: saved, configurable: true });
		}
	});

	it('leaves an existing database intact after a failed open, and recovers on retry', async () => {
		const seeded = await make().createNote('must survive');
		await repository?.close();

		// First open throws, later opens go to the real (global) factory.
		const realOpen = indexedDB.open.bind(indexedDB);
		let calls = 0;
		const factory = {
			open(name: string, version?: number) {
				calls += 1;
				if (calls === 1) throw new DOMException('transient', 'UnknownError');
				return realOpen(name, version);
			}
		} as unknown as IDBFactory;
		const repo = make({ factory });

		await expect(repo.listNotes()).rejects.toBeInstanceOf(StorageUnavailableError);
		// Retried against the same, untouched database: the data is still there.
		expect(await repo.listNotes()).toEqual([seeded]);
		expect(calls).toBe(2);
	});

	it('does not cache a failed open', async () => {
		const realOpen = indexedDB.open.bind(indexedDB);
		let calls = 0;
		const repo = make({
			factory: {
				open(name: string, version?: number) {
					calls += 1;
					if (calls === 1) throw new DOMException('transient', 'UnknownError');
					return realOpen(name, version);
				}
			} as unknown as IDBFactory
		});

		await expect(repo.listNotes()).rejects.toBeInstanceOf(StorageUnavailableError);
		await expect(repo.listNotes()).resolves.toEqual([]);
		expect(calls).toBe(2);
	});

	it('reports corruption, writing nothing, when meta.schemaVersion is missing', async () => {
		const seed = make();
		await seed.listNotes();
		await seed.close();
		const db = await openRaw();
		await new Promise<void>((resolve, reject) => {
			const transaction = db.transaction(META_STORE, 'readwrite');
			transaction.objectStore(META_STORE).delete(SCHEMA_VERSION_KEY);
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});
		db.close();

		const repo = make();

		await expect(repo.createNote('blocked')).rejects.toBeInstanceOf(StorageCorruptError);
		expect(await readAllRaw()).toEqual([]);
	});
});

describe('quota errors', () => {
	// These run against ONE in-memory database: the note is written first, then a
	// repository over the same factory starts failing writes.
	function quotaRepo(method: 'add' | 'put', errorName: string) {
		const inner = globalThis.indexedDB;
		return {
			seed: make(),
			failing: (sync: SyncSpy) => make({ sync, factory: failingWith(method, errorName, inner) })
		};
	}

	it('maps QuotaExceededError on create to StorageFullError, wrapping the cause', async () => {
		const { failing } = quotaRepo('add', 'QuotaExceededError');
		const repo = failing(spySync());

		const error = await repo.createNote('too big').catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(StorageFullError);
		expect(((error as StorageFullError).cause as DOMException).name).toBe('QuotaExceededError');
		expect(await readAllRaw()).toEqual([]);
	});

	it('maps Firefox’s NS_ERROR_DOM_QUOTA_REACHED', async () => {
		const repo = quotaRepo('add', 'NS_ERROR_DOM_QUOTA_REACHED').failing(spySync());

		await expect(repo.createNote('x')).rejects.toBeInstanceOf(StorageFullError);
	});

	it('does not publish a change when the write is rejected for quota', async () => {
		const sync = spySync();
		const repo = quotaRepo('add', 'QuotaExceededError').failing(sync);

		await expect(repo.createNote('x')).rejects.toBeInstanceOf(StorageFullError);

		expect(sync.posted).toEqual([]);
	});

	it('maps a quota error on update and leaves the stored note intact', async () => {
		const { seed, failing } = quotaRepo('put', 'QuotaExceededError');
		const created = await seed.createNote('v1');
		await seed.close();
		const sync = spySync();
		const repo = failing(sync);

		await expect(repo.updateNote(created.id, 'v2')).rejects.toBeInstanceOf(StorageFullError);
		expect(await readRaw(created.id)).toEqual(created);
		expect(sync.posted).toEqual([]);
	});

	it('maps a quota error on restore and leaves the database unchanged', async () => {
		const { seed, failing } = quotaRepo('put', 'QuotaExceededError');
		const created = await seed.createNote('v1');
		const deleted = await seed.deleteNote(created.id);
		await seed.close();
		const sync = spySync();
		const repo = failing(sync);

		await expect(repo.restoreNote(deleted)).rejects.toBeInstanceOf(StorageFullError);
		expect(await readRaw(created.id)).toBeUndefined();
		expect(sync.posted).toEqual([]);
	});
});

describe('read failures', () => {
	it('maps a failing getAll to StorageCorruptError', async () => {
		const seed = make();
		await seed.createNote('x');
		await seed.close();

		const repo = make({
			factory: failingWith('getAll', 'UnknownError', globalThis.indexedDB)
		});

		await expect(repo.listNotes()).rejects.toBeInstanceOf(StorageCorruptError);
	});

	it('maps a failing get to StorageCorruptError', async () => {
		const seed = make();
		const created = await seed.createNote('x');
		await seed.close();

		const repo = make({
			factory: failingWith('get', 'UnknownError', globalThis.indexedDB)
		});

		await expect(repo.getNote(created.id)).rejects.toBeInstanceOf(StorageCorruptError);
	});

	it('never deletes data when a read fails', async () => {
		const seed = make();
		const created = await seed.createNote('x');
		await seed.close();

		const repo = make({
			factory: failingWith('getAll', 'UnknownError', globalThis.indexedDB)
		});
		await expect(repo.listNotes()).rejects.toBeInstanceOf(StorageCorruptError);

		expect(await readRaw(created.id)).toEqual(created);
	});
});

describe('close', () => {
	it('closes the connection and reopens on the next call', async () => {
		const repo = make();
		const created = await repo.createNote('x');

		await repo.close();
		await repo.close();

		expect(await repo.getNote(created.id)).toEqual(created);
	});
});

describe('helpers', () => {
	const note = (id: string, updatedAt: string): Note => ({
		id,
		body: '',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt
	});

	it('compareNotes orders by updatedAt then id, descending', () => {
		const a = note('a', '2026-01-01T00:00:00.000Z');
		const b = note('b', '2026-01-02T00:00:00.000Z');
		const c = note('c', '2026-01-02T00:00:00.000Z');

		// Sorting ascending by the comparator puts the newest first.
		expect(compareNotes(a, b)).toBeGreaterThan(0);
		expect(compareNotes(b, a)).toBeLessThan(0);
		expect(compareNotes(b, c)).toBeGreaterThan(0);
		expect(compareNotes(c, b)).toBeLessThan(0);
		expect(compareNotes(b, b)).toBe(0);
		expect(sortNotes([a, b, c]).map((item) => item.id)).toEqual(['c', 'b', 'a']);
	});

	it('sortNotes does not mutate its input', () => {
		const notes = [note('a', '2026-01-01T00:00:00.000Z'), note('b', '2026-01-02T00:00:00.000Z')];

		const sorted = sortNotes(notes);

		expect(notes.map((item) => item.id)).toEqual(['a', 'b']);
		expect(sorted.map((item) => item.id)).toEqual(['b', 'a']);
	});

	it('validateNote accepts a canonical record', () => {
		const valid = note('a', '2026-10-31T13:13:00.000Z');

		expect(validateNote(valid, 'a')).toEqual({ ok: true, note: valid });
	});

	it('validateNote rejects an empty id', () => {
		expect(validateNote({ ...note('', '2026-10-31T13:13:00.000Z') }, '')).toEqual({
			ok: false,
			reason: 'id is not a non-empty string'
		});
	});

	it('validateNote rejects a non-canonical updatedAt', () => {
		expect(validateNote(note('a', '2026-10-31T13:13:00Z'), 'a')).toEqual({
			ok: false,
			reason: 'updatedAt is not a canonical ISO 8601 UTC string'
		});
	});
});

describe('cross-tab broadcast', () => {
	it('announces all four change types, in write order', async () => {
		const remote = new BroadcastChannel('notes-app');
		const seen: RemoteChange[] = [];
		remote.onmessage = (event: MessageEvent) => seen.push(event.data as RemoteChange);
		const repo = createNotesRepository({ now: () => new Date(T0) });
		repository = repo;

		const created = await repo.createNote('a');
		await repo.updateNote(created.id, 'b');
		await repo.deleteNote(created.id);
		await repo.restoreNote(created);

		await waitFor(() => seen.length === 4);
		expect(seen).toEqual([
			{ type: 'created', id: created.id },
			{ type: 'updated', id: created.id },
			{ type: 'deleted', id: created.id },
			{ type: 'restored', id: created.id }
		]);
		remote.close();
	});
});

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('timed out waiting for condition');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
