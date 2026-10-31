/**
 * IndexedDB repository for notes.
 *
 * ## Invariants (do not relax these)
 * - **Nothing is ever deleted, cleared or recreated behind the user's back.**
 *   If the database cannot be opened or read, a typed error is thrown and the
 *   stored bytes are left exactly as found. There is deliberately no "reset"
 *   or "recover by starting over" path anywhere in this file.
 * - **Records that fail validation are never rewritten or removed.** They are
 *   skipped, reported (`skippedRecords` / `onInvalidRecord`), and every valid
 *   record still loads. Writing over such a record is refused with
 *   `StorageCorruptError` instead of overwriting bytes we cannot read.
 * - **A change is announced cross-tab only after its transaction commits**
 *   (`tx.done` resolves), so `sync` never advertises a write that did not land.
 *
 * ## Adding a migration
 * 1. Bump `SCHEMA_VERSION` by one.
 * 2. Append to `MIGRATIONS` an entry keyed by that version, e.g.
 *    `{ version: 2, migrate({ transaction }) { ... } }`, where the body rewrites
 *    records through `transaction.objectStore(NOTES_STORE)`. It runs inside the
 *    `versionchange` transaction, so throwing aborts the whole upgrade and both
 *    the previous schema and its data stay intact.
 * 3. Make it a no-op on an empty store: a fresh install opens straight at the
 *    latest version and runs every migration with nothing to transform.
 * Migrations transform data; the v1 structure is created in `upgrade` first, so
 * a migration can assume the stores and indexes already exist.
 */
import { unwrap, wrap, type IDBPTransaction } from 'idb';
import {
	NoteMissingError,
	StorageCorruptError,
	StorageFullError,
	StorageUnavailableError,
	isStorageError,
	type InvalidRecord,
	type Note,
	type NoteDatabase,
	type NoteDatabaseSchema
} from './types';
import { createNotesSync, type NotesSync } from './sync';

export const DB_NAME = 'notes-app';
export const NOTES_STORE = 'notes';
export const META_STORE = 'meta';
export const UPDATED_AT_INDEX = 'by-updatedAt';
export const SCHEMA_VERSION_KEY = 'schemaVersion';
export const SCHEMA_VERSION = 1;

/** The `versionchange` transaction a migration receives. */
export type MigrationTransaction = IDBPTransaction<
	NoteDatabaseSchema,
	ArrayLike<'notes' | 'meta'>,
	'versionchange'
>;

export interface MigrationContext {
	/** Version the database had before this upgrade (`0` for a fresh install). */
	oldVersion: number;
	/** Version being installed. */
	newVersion: number;
	/** Open and usable; `tx.done` settles only after `migrate` returns. */
	transaction: MigrationTransaction;
}

export interface Migration {
	/** Schema version this migration installs (2 or later in practice). */
	version: number;
	/** Runs inside the `versionchange` transaction; throwing aborts the upgrade. */
	migrate(context: MigrationContext): void;
}

/** Shipped migrations, ascending by version. Append here when bumping the schema. */
export const MIGRATIONS: readonly Migration[] = [];

export interface RepositoryOptions {
	/** Injected clock, so tests are deterministic. Defaults to `() => new Date()`. */
	now?: () => Date;
	/** Injected id generator. Defaults to `crypto.randomUUID()`. */
	createId?: () => string;
	/** Cross-tab channel. Defaults to a real `BroadcastChannel('notes-app')`. */
	sync?: NotesSync;
	/** Called once per record skipped while reading. Never called for writes. */
	onInvalidRecord?: (record: InvalidRecord) => void;
	/** Extra migrations appended to `MIGRATIONS`. */
	migrations?: readonly Migration[];
	/** Schema version to open. Defaults to `SCHEMA_VERSION`. */
	schemaVersion?: number;
	/** IndexedDB implementation. Defaults to `globalThis.indexedDB`. */
	factory?: IDBFactory;
	/** Database name. Defaults to `DB_NAME`. */
	dbName?: string;
}

export interface NotesRepository {
	/** Valid notes, most recently edited first. Invalid records are skipped. */
	listNotes(): Promise<Note[]>;
	/** `undefined` when no such note exists. */
	getNote(id: string): Promise<Note | undefined>;
	createNote(body: string): Promise<Note>;
	/** Bumps `updatedAt`, keeps `createdAt`. */
	updateNote(id: string, body: string): Promise<Note>;
	/** Returns the removed note, so the caller can offer Undo. */
	deleteNote(id: string): Promise<Note>;
	/** Puts back the exact note (same id and dates). */
	restoreNote(note: Note): Promise<void>;
	/** Records skipped by the most recent read; replaced on every read. */
	readonly skippedRecords: readonly InvalidRecord[];
	/** Closes the connection; the next call reopens it. */
	close(): Promise<void>;
}

/**
 * Order of the notes list: `updatedAt` descending, with `id` descending as a
 * deterministic tie-break (two notes saved in the same millisecond must not
 * swap places between renders, or Undo would restore to a different position).
 */
export function compareNotes(a: Note, b: Note): number {
	if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
	if (a.id !== b.id) return a.id < b.id ? 1 : -1;
	return 0;
}

export function sortNotes(notes: readonly Note[]): Note[] {
	return [...notes].sort(compareNotes);
}

function isCanonicalIsoDate(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const ms = Date.parse(value);
	if (Number.isNaN(ms)) return false;
	// Only the exact `toISOString()` form we write is accepted: this rejects
	// date-only strings, local offsets and out-of-range values JS would roll over.
	return new Date(ms).toISOString() === value;
}

export type NoteValidation = { ok: true; note: Note } | { ok: false; reason: string };

/** Validates a stored value against the `Note` contract, including its key. */
export function validateNote(value: unknown, key: unknown): NoteValidation {
	if (typeof value !== 'object' || value === null) {
		return { ok: false, reason: 'record is not an object' };
	}
	const record = value as Record<string, unknown>;
	if (typeof record.id !== 'string' || record.id.length === 0) {
		return { ok: false, reason: 'id is not a non-empty string' };
	}
	if (typeof key === 'string' && record.id !== key) {
		return { ok: false, reason: 'id does not match the record key' };
	}
	if (typeof record.body !== 'string') {
		return { ok: false, reason: 'body is not a string' };
	}
	if (!isCanonicalIsoDate(record.createdAt)) {
		return { ok: false, reason: 'createdAt is not a canonical ISO 8601 UTC string' };
	}
	if (!isCanonicalIsoDate(record.updatedAt)) {
		return { ok: false, reason: 'updatedAt is not a canonical ISO 8601 UTC string' };
	}
	return {
		ok: true,
		note: {
			id: record.id,
			body: record.body,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt
		}
	};
}

const QUOTA_ERROR_NAMES = new Set(['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED']);

/** `QuotaExceededError` in every browser flavor we support (incl. Firefox's name). */
function isQuotaError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const candidate = error as { name?: unknown; code?: unknown };
	return (
		(typeof candidate.name === 'string' && QUOTA_ERROR_NAMES.has(candidate.name)) ||
		// Legacy numeric code 22, still how some engines report a full quota.
		candidate.code === 22
	);
}

function describe(error: unknown): string {
	if (typeof error === 'object' && error !== null) {
		const named = error as { message?: unknown; name?: unknown };
		if (typeof named.message === 'string' && named.message.length > 0) return named.message;
		if (typeof named.name === 'string') return named.name;
	}
	return String(error);
}

/**
 * Maps whatever IndexedDB threw into a typed error. Our own errors pass
 * through untouched, so a deliberate refusal is never relabelled as a quota
 * problem or an outage.
 */
function mapWriteError(error: unknown): Error {
	if (error instanceof NoteMissingError || isStorageError(error)) return error;
	if (isQuotaError(error)) return new StorageFullError(undefined, error);
	return new StorageUnavailableError(`The note could not be saved (${describe(error)}).`, error);
}

function mapReadError(error: unknown): Error {
	if (isStorageError(error)) return error;
	return new StorageCorruptError(`Stored notes could not be read (${describe(error)}).`, error);
}

function mapOpenError(error: unknown): StorageUnavailableError {
	if (error instanceof StorageUnavailableError) return error;
	return new StorageUnavailableError(
		`Notes storage could not be opened (${describe(error)}). Stored data was left untouched.`,
		error
	);
}

function assertBody(body: unknown): asserts body is string {
	if (typeof body !== 'string') throw new TypeError('A note body must be a string.');
}

/**
 * `idb` types `wrap()` for a generic transaction as `readonly` (it cannot see
 * the mode), but inside `upgradeneeded` the transaction is always
 * `versionchange`. This is the single place that reconciles the two.
 */
function upgradeTransaction(transaction: IDBTransaction | null): MigrationTransaction {
	if (transaction === null) {
		throw new StorageUnavailableError('The upgrade transaction is not available.');
	}
	return wrap(transaction) as unknown as MigrationTransaction;
}

export function createNotesRepository(options: RepositoryOptions = {}): NotesRepository {
	const now = options.now ?? (() => new Date());
	const createId = options.createId ?? (() => crypto.randomUUID());
	const sync = options.sync ?? createNotesSync();
	const dbName = options.dbName ?? DB_NAME;
	const schemaVersion = options.schemaVersion ?? SCHEMA_VERSION;
	const migrations = [...MIGRATIONS, ...(options.migrations ?? [])].sort(
		(a, b) => a.version - b.version
	);
	let skipped: readonly InvalidRecord[] = [];
	// One connection shared by every call; null means "closed or never opened".
	let connection: Promise<NoteDatabase> | null = null;

	function reportInvalid(record: InvalidRecord): void {
		options.onInvalidRecord?.(record);
	}

	function runUpgrade(
		db: NoteDatabase,
		oldVersion: number,
		newVersion: number,
		transaction: MigrationTransaction
	): void {
		if (oldVersion < 1) {
			const notes = db.createObjectStore(NOTES_STORE, { keyPath: 'id' });
			notes.createIndex(UPDATED_AT_INDEX, 'updatedAt');
			db.createObjectStore(META_STORE);
		}
		for (const migration of migrations) {
			if (migration.version > oldVersion && migration.version <= newVersion) {
				migration.migrate({ oldVersion, newVersion, transaction });
			}
		}
		transaction.objectStore(META_STORE).put(newVersion, SCHEMA_VERSION_KEY);
	}

	async function openOnce(): Promise<NoteDatabase> {
		const factory = options.factory ?? globalThis.indexedDB;
		if (!factory) {
			throw new StorageUnavailableError('IndexedDB is not available in this environment.');
		}
		return await new Promise<NoteDatabase>((resolve, reject) => {
			let request: IDBOpenDBRequest;
			try {
				// `factory.open` (not `openDB`) so an injected `IDBFactory` is honoured;
				// `wrap` then gives the promise-based `idb` API used everywhere else.
				request = factory.open(dbName, schemaVersion);
			} catch (error) {
				// Some privacy modes throw synchronously out of `indexedDB.open`.
				reject(mapOpenError(error));
				return;
			}

			request.addEventListener('upgradeneeded', (event) => {
				const transaction = upgradeTransaction(request.transaction);
				// `idb` caches a `done` promise per transaction. If a migration throws,
				// the upgrade aborts and that promise rejects; observing it here keeps a
				// deliberate rollback from surfacing as an unhandled rejection.
				void transaction.done.catch(() => {});
				// A throw here aborts the versionchange transaction: the upgrade rolls
				// back and the previous data survives untouched.
				runUpgrade(
					wrap(request.result) as NoteDatabase,
					event.oldVersion,
					event.newVersion ?? schemaVersion,
					transaction
				);
			});
			request.addEventListener('blocked', () => {
				reject(
					new StorageUnavailableError(
						'Another tab is holding an older version of the notes database open.'
					)
				);
			});

			(wrap(request) as Promise<NoteDatabase | undefined>).then(
				(db) => {
					if (db === undefined) {
						reject(new StorageUnavailableError('The notes database did not open.'));
						return;
					}
					// An upgrade elsewhere needs us to step aside so it is not blocked
					// forever waiting on us; the next call reopens at the new version.
					const raw = unwrap(db) as IDBDatabase;
					raw.addEventListener('versionchange', () => {
						connection = null;
						db.close();
					});
					resolve(db);
				},
				(error: unknown) => reject(mapOpenError(error))
			);
		});
	}

	async function open(): Promise<NoteDatabase> {
		if (connection === null) {
			connection = openOnce().catch((error: unknown) => {
				// Never cache a failed open: the next call retries from scratch.
				connection = null;
				throw mapOpenError(error);
			});
		}
		const db = await connection;
		let stored: unknown;
		try {
			stored = await db.get(META_STORE, SCHEMA_VERSION_KEY);
		} catch (error) {
			throw mapReadError(error);
		}
		assertSchemaVersion(stored);
		return db;
	}

	/**
	 * The stored version is read back on every open: if that `meta` record was
	 * tampered with or truncated, we report corruption instead of writing into a
	 * database whose shape we cannot vouch for.
	 */
	function assertSchemaVersion(stored: unknown): void {
		if (stored !== schemaVersion) {
			throw new StorageCorruptError(
				`Stored schema version (${String(stored)}) does not match the expected ${schemaVersion}.`
			);
		}
	}

	/**
	 * Runs `body` in a `readwrite` transaction on `notes` and resolves only once
	 * the transaction committed. Any throw aborts the transaction (so a partially
	 * applied write can never survive) and the rejection of `tx.done` is always
	 * observed, so a failed write cannot surface as an unhandled rejection.
	 */
	async function writeTransaction<T>(
		db: NoteDatabase,
		body: (store: WritableStore) => Promise<T> | T
	): Promise<T> {
		const transaction = db.transaction(NOTES_STORE, 'readwrite');
		try {
			const result = await body(transaction.store);
			await transaction.done;
			return result;
		} catch (error) {
			void transaction.done.catch(() => {});
			try {
				transaction.abort();
			} catch {
				/* already finished: the caller's error is the one that matters */
			}
			throw error;
		}
	}

	async function readNote(
		db: NoteDatabase,
		id: string
	): Promise<{ note: Note } | { invalid: InvalidRecord } | undefined> {
		const raw: unknown = await db.get(NOTES_STORE, id);
		if (raw === undefined) return undefined;
		const validation = validateNote(raw, id);
		if (validation.ok) return { note: validation.note };
		return { invalid: { key: id, reason: validation.reason, value: raw } };
	}

	return {
		get skippedRecords() {
			return skipped;
		},

		async listNotes() {
			const db = await open();
			let entries: { key: unknown; value: unknown }[];
			try {
				const transaction = db.transaction(NOTES_STORE, 'readonly');
				// Keys and values are read in one transaction so they stay paired;
				// reading the key from the value alone could never detect a record
				// whose stored key disagrees with its `id`.
				const [values, keys] = await Promise.all([
					transaction.store.getAll() as Promise<unknown[]>,
					transaction.store.getAllKeys() as Promise<unknown[]>
				]);
				await transaction.done;
				entries = keys.map((key, index) => ({ key, value: values[index] }));
			} catch (error) {
				throw mapReadError(error);
			}
			const notes: Note[] = [];
			const invalid: InvalidRecord[] = [];
			for (const { key, value } of entries) {
				const validation = validateNote(value, key);
				if (validation.ok) {
					notes.push(validation.note);
				} else {
					invalid.push({ key, reason: validation.reason, value });
				}
			}
			skipped = invalid;
			for (const record of invalid) reportInvalid(record);
			// Sorted in memory rather than through `by-updatedAt`: the index only
			// holds records with a usable key, so a record with a broken `updatedAt`
			// must be *reported* here, not silently absent from the result.
			return sortNotes(notes);
		},

		async getNote(id) {
			const db = await open();
			let result: Awaited<ReturnType<typeof readNote>>;
			try {
				result = await readNote(db, id);
			} catch (error) {
				throw mapReadError(error);
			}
			if (result === undefined) return undefined;
			if ('invalid' in result) {
				skipped = [result.invalid];
				reportInvalid(result.invalid);
				throw new StorageCorruptError(
					`The stored note ${id} is unreadable (${result.invalid.reason}) and was left untouched.`
				);
			}
			return result.note;
		},

		async createNote(body) {
			assertBody(body);
			const timestamp = now().toISOString();
			const note: Note = { id: createId(), body, createdAt: timestamp, updatedAt: timestamp };
			const db = await open();
			try {
				await writeTransaction(db, (store) => store.add(note));
			} catch (error) {
				throw mapWriteError(error);
			}
			sync.post({ type: 'created', id: note.id });
			return note;
		},

		async updateNote(id, body) {
			assertBody(body);
			const timestamp = now().toISOString();
			const db = await open();
			let updated: Note;
			try {
				updated = await writeTransaction(db, async (store) => {
					const raw: unknown = await store.get(id);
					if (raw === undefined) throw new NoteMissingError(id);
					const validation = validateNote(raw, id);
					if (!validation.ok) {
						// Writing now would replace bytes we cannot read: refuse.
						throw new StorageCorruptError(
							`The stored note ${id} is unreadable (${validation.reason}) and was left untouched.`
						);
					}
					const next: Note = { ...validation.note, body, updatedAt: timestamp };
					await store.put(next);
					return next;
				});
			} catch (error) {
				throw mapWriteError(error);
			}
			sync.post({ type: 'updated', id });
			return updated;
		},

		async deleteNote(id) {
			const db = await open();
			let deleted: Note;
			try {
				deleted = await writeTransaction(db, async (store) => {
					const raw: unknown = await store.get(id);
					if (raw === undefined) throw new NoteMissingError(id);
					const validation = validateNote(raw, id);
					if (!validation.ok) {
						throw new StorageCorruptError(
							`The stored note ${id} is unreadable (${validation.reason}) and was left untouched.`
						);
					}
					await store.delete(id);
					return validation.note;
				});
			} catch (error) {
				throw mapWriteError(error);
			}
			sync.post({ type: 'deleted', id });
			return deleted;
		},

		async restoreNote(note) {
			const validation = validateNote(note, note?.id);
			if (!validation.ok) {
				throw new TypeError(`Refusing to restore an invalid note (${validation.reason}).`);
			}
			const restored = validation.note;
			const db = await open();
			try {
				await writeTransaction(db, async (store) => {
					const raw: unknown = await store.get(restored.id);
					if (raw !== undefined && !validateNote(raw, restored.id).ok) {
						throw new StorageCorruptError(
							`The stored note ${restored.id} is unreadable and was left untouched.`
						);
					}
					await store.put(restored);
				});
			} catch (error) {
				throw mapWriteError(error);
			}
			sync.post({ type: 'restored', id: restored.id });
		},

		async close() {
			const pending = connection;
			connection = null;
			const db = await pending?.catch(() => null);
			db?.close();
		}
	};
}

/** The subset of `idb`'s object store the write path needs. */
type WritableStore = {
	get(key: string): Promise<unknown>;
	put(value: Note): Promise<unknown>;
	add(value: Note): Promise<unknown>;
	delete(key: string): Promise<void>;
};
