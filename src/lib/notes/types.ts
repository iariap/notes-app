/**
 * Data model and typed failures for the notes storage layer.
 *
 * Users have no backup and no server, so every failure is explicit and typed:
 * callers can tell "the browser cannot store anything right now" (transient,
 * worth retrying) apart from "this note is gone" or "stored bytes are
 * unreadable" (never silently repaired — see `repository.ts`).
 */
import type { DBSchema, IDBPDatabase } from 'idb';

export interface Note {
	/** `crypto.randomUUID()`. Stable across delete/restore (Undo keeps it). */
	id: string;
	/** Markdown source. Rendered HTML is never stored. */
	body: string;
	/** ISO 8601 UTC, e.g. `"2026-10-31T13:13:00.000Z"`. */
	createdAt: string;
	/** ISO 8601 UTC. Used for ordering only, never displayed. */
	updatedAt: string;
}

/** A stored record that does not satisfy `Note`. Kept in the DB, never repaired. */
export interface InvalidRecord {
	/** The record's key, as found in the store. */
	key: unknown;
	/** Why the record was skipped, in one sentence. */
	reason: string;
	/** The raw stored value, for reporting only. */
	value: unknown;
}

/**
 * The write did not fit: the origin's quota is exhausted (`QuotaExceededError`).
 * `cause` keeps the original `DOMException` for logs and debugging.
 */
export class StorageFullError extends Error {
	readonly cause: unknown;

	constructor(message = 'Storage is full: the note could not be saved.', cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = 'StorageFullError';
		this.cause = cause;
	}
}

/**
 * IndexedDB cannot be opened or read at all: blocked by browser policy,
 * private mode, a corrupted database, or a version conflict.
 *
 * Callers must not treat this as "empty database": the data may still be there.
 */
export class StorageUnavailableError extends Error {
	readonly cause: unknown;

	constructor(message = 'Notes storage is unavailable in this browser session.', cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = 'StorageUnavailableError';
		this.cause = cause;
	}
}

/**
 * A record (or the whole database) is unreadable. The data is left exactly as
 * found: nothing is deleted, cleared or recreated.
 */
export class StorageCorruptError extends Error {
	readonly cause: unknown;

	constructor(message = 'Stored notes data is unreadable.', cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = 'StorageCorruptError';
		this.cause = cause;
	}
}

/**
 * The note is not stored (deleted here or in another tab) between the read and
 * the write. Distinct from corruption: there is nothing to protect.
 */
export class NoteMissingError extends Error {
	constructor(id: string) {
		super(`Note ${id} is no longer stored.`);
		this.name = 'NoteMissingError';
	}
}

export type StorageError = StorageFullError | StorageUnavailableError | StorageCorruptError;

export function isStorageError(error: unknown): error is StorageError {
	return (
		error instanceof StorageFullError ||
		error instanceof StorageUnavailableError ||
		error instanceof StorageCorruptError
	);
}

/** Schema consumed by `idb`'s `openDB`: the keys, values and indexes per store. */
export interface NoteDatabaseSchema extends DBSchema {
	notes: {
		key: string;
		value: Note;
		indexes: { 'by-updatedAt': string };
	};
	meta: {
		key: string;
		value: unknown;
	};
}

/** The open `idb` handle, as handed to migrations. */
export type NoteDatabase = IDBPDatabase<NoteDatabaseSchema>;
