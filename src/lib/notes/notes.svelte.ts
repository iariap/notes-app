/**
 * Reactive notes store (Svelte 5 runes) consumed by the UI.
 *
 * Every mutating method follows the same discipline: **write first, then
 * update state**. If the repository rejects, the in-memory state is left
 * exactly as it was and the caller gets the typed error, so the UI can keep the
 * user's text on screen without ever showing a change that did not land.
 *
 * Cross-tab: a remote change reloads the affected note (or drops it, on a
 * delete) instead of reloading the whole list, so the list stays responsive
 * with hundreds of notes. Last write wins per note — the newest committed
 * record is what every tab converges to, and nothing is ever merged into a
 * record the user cannot see.
 */
import {
	createNotesRepository,
	sortNotes,
	type NotesRepository,
	type RepositoryOptions
} from './repository';
import { createNotesSync, type NotesSync, type RemoteChange } from './sync';
import { StorageCorruptError, NoteMissingError, isStorageError, type Note } from './types';

export type NotesStatus = 'loading' | 'ready' | 'error';

export interface NotesStoreOptions extends RepositoryOptions {
	/** Reuse an existing repository (and its connection) instead of creating one. */
	repository?: NotesRepository;
	/** Reuse an existing channel instead of creating one. */
	sync?: NotesSync;
}

export class NotesStore {
	/** Sorted current notes, most recently edited first. */
	notes = $state<Note[]>([]);
	/** `loading` until the first read settles. */
	status = $state<NotesStatus>('loading');
	/** The last failure, typed. `null` while healthy. */
	error = $state<Error | null>(null);

	readonly #repository: NotesRepository;
	readonly #sync: NotesSync;
	readonly #ownsSync: boolean;
	readonly #unsubscribe: () => void;
	// Bumped on every local write and remote reload so a slow initial load cannot
	// overwrite newer state (it only applies if nothing changed since it started).
	#revision = $state(0);

	constructor(options: NotesStoreOptions = {}) {
		this.#repository = options.repository ?? createNotesRepository(options);
		this.#sync = options.sync ?? createNotesSync();
		this.#ownsSync = options.sync === undefined;
		this.#unsubscribe = this.#sync.onRemoteChange((change) => {
			void this.#applyRemoteChange(change);
		});
	}

	get repository(): NotesRepository {
		return this.#repository;
	}

	/** Loads the list. Safe to call more than once; the last call wins. */
	async load(): Promise<void> {
		const revision = this.#revision;
		this.status = 'loading';
		try {
			const notes = await this.#repository.listNotes();
			if (revision !== this.#revision) return;
			this.notes = notes;
			this.error = null;
			this.status = 'ready';
		} catch (error) {
			if (revision !== this.#revision) return;
			this.#fail(error);
		}
	}

	async createNote(body: string): Promise<Note> {
		const note = await this.#guard(() => this.#repository.createNote(body));
		this.#revision += 1;
		this.notes = sortNotes([...this.notes.filter((current) => current.id !== note.id), note]);
		this.status = 'ready';
		this.error = null;
		return note;
	}

	async updateNote(id: string, body: string): Promise<Note> {
		let note: Note;
		try {
			note = await this.#repository.updateNote(id, body);
		} catch (error) {
			// A record that disappeared between the read and the write (#8: this
			// tab, or another one, deleted it) is a lost race, not a broken store:
			// the list is intact and `notes` is already right, so flipping
			// `status` to `error` would replace a healthy list with "Couldn't load
			// your notes". The typed error still reaches the caller, and the last
			// failure stays visible in `error` for anyone inspecting it.
			if (error instanceof NoteMissingError) {
				this.error = error;
				throw error;
			}
			this.#fail(error);
			throw error;
		}
		this.#revision += 1;
		this.notes = sortNotes([...this.notes.filter((current) => current.id !== note.id), note]);
		this.status = 'ready';
		this.error = null;
		return note;
	}

	async deleteNote(id: string): Promise<Note> {
		const note = await this.#guard(() => this.#repository.deleteNote(id));
		this.#revision += 1;
		this.notes = this.notes.filter((current) => current.id !== id);
		this.status = 'ready';
		this.error = null;
		return note;
	}

	async restoreNote(note: Note): Promise<void> {
		await this.#guard(() => this.#repository.restoreNote(note));
		this.#revision += 1;
		this.notes = sortNotes([...this.notes.filter((current) => current.id !== note.id), note]);
		this.status = 'ready';
		this.error = null;
	}

	/** Stops reacting to remote changes and closes the channel it created. */
	dispose(): void {
		this.#unsubscribe();
		if (this.#ownsSync) this.#sync.close();
	}

	/** Runs a repository write, turning a failure into typed state plus a throw. */
	async #guard<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			this.#fail(error);
			throw error;
		}
	}

	#fail(error: unknown): void {
		this.error = normalizeError(error);
		this.status = 'error';
	}

	/**
	 * Reloads just the affected note; a delete removes it locally.
	 *
	 * `deleted` is applied synchronously, so it cannot be superseded mid-flight.
	 * For other changes the revision captured on entry is compared after the
	 * await: if a local write landed in between, it is newer than what this read
	 * would return, so the result is dropped (last write wins).
	 */
	async #applyRemoteChange(change: RemoteChange): Promise<void> {
		if (change.type === 'deleted') {
			this.notes = this.notes.filter((current) => current.id !== change.id);
			return;
		}
		const revision = this.#revision;
		try {
			const note = await this.#repository.getNote(change.id);
			if (revision !== this.#revision) return;
			const withoutNote = this.notes.filter((current) => current.id !== change.id);
			this.notes = note === undefined ? withoutNote : sortNotes([...withoutNote, note]);
			if (this.status === 'error') {
				this.error = null;
				this.status = 'ready';
			}
		} catch (error) {
			if (revision !== this.#revision) return;
			this.#fail(error);
		}
	}
}

/** Turns anything thrown into an `Error` we can hand to the UI verbatim. */
export function normalizeError(error: unknown): Error {
	if (isStorageError(error) || error instanceof NoteMissingError) return error;
	if (error instanceof Error) {
		return new StorageCorruptError(error.message, error);
	}
	return new StorageCorruptError(`Unexpected storage failure: ${String(error)}`);
}
