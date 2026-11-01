import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { NotesStore, normalizeError } from '$lib/notes/notes.svelte';
import { createNotesRepository, type NotesRepository } from '$lib/notes/repository';
import { createNotesSync, type NotesSync, type RemoteChange } from '$lib/notes/sync';
import {
	NoteMissingError,
	StorageCorruptError,
	StorageFullError,
	StorageUnavailableError,
	type Note
} from '$lib/notes/types';
import type { NotesStatus } from '$lib/notes/notes.svelte';
import { failingWith } from './helpers/failing-idb';
import { throwingOpenFactory } from './helpers/open-failures';
import { probeEffects } from './helpers/effect-probe.svelte';

const T0 = Date.parse('2026-10-31T13:13:00.000Z');

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
	/** Simulates a change arriving from another tab. */
	emit(change: RemoteChange): void;
}

function spySync(): SyncSpy {
	const posted: RemoteChange[] = [];
	const handlers = new Set<(change: RemoteChange) => void>();
	return {
		posted,
		post(change) {
			posted.push(change);
		},
		onRemoteChange(handler) {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
		close() {
			handlers.clear();
		},
		emit(change) {
			for (const handler of [...handlers]) handler(change);
		}
	};
}

let store: NotesStore | undefined;
let repository: NotesRepository | undefined;

function makeStore(
	options: { repository?: NotesRepository; sync?: NotesSync } & Parameters<
		typeof createNotesRepository
	>[0] = {}
): NotesStore {
	store = new NotesStore({ now: steppingClock(), ...options });
	return store;
}

async function flush(): Promise<void> {
	// IndexedDB callbacks are macrotasks, so draining microtasks is not enough:
	// yield to the event loop a few times and then flush Svelte's effects.
	for (let index = 0; index < 8; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
});

afterEach(async () => {
	store?.dispose();
	await store?.repository.close();
	await repository?.close();
	store = undefined;
	repository = undefined;
});

describe('initial state', () => {
	it('starts loading, with no notes and no error', () => {
		const notes = makeStore();

		expect(notes.notes).toEqual([]);
		expect(notes.status).toBe('loading');
		expect(notes.error).toBeNull();
	});
});

describe('load', () => {
	it('loads notes sorted by updatedAt descending and becomes ready', async () => {
		const repo = createNotesRepository({ now: steppingClock(), sync: spySync() });
		repository = repo;
		const first = await repo.createNote('first');
		const second = await repo.createNote('second');

		const notes = makeStore({ repository: repo });
		await notes.load();

		expect(notes.status).toBe('ready');
		expect(notes.notes.map((note) => note.id)).toEqual([second.id, first.id]);
		expect(notes.error).toBeNull();
	});

	it('reports an error state when the read fails', async () => {
		const repo = createNotesRepository({
			sync: spySync(),
			factory: throwingOpenFactory('SecurityError')
		});
		repository = repo;
		const notes = makeStore({ repository: repo });

		await notes.load();

		expect(notes.status).toBe('error');
		expect(notes.error).toBeInstanceOf(StorageUnavailableError);
		expect(notes.notes).toEqual([]);
	});

	it('is idempotent: loading twice keeps the same result', async () => {
		const repo = createNotesRepository({ now: steppingClock(), sync: spySync() });
		repository = repo;
		const created = await repo.createNote('x');

		const notes = makeStore({ repository: repo });
		await notes.load();
		await notes.load();

		expect(notes.notes).toEqual([created]);
	});

	it('does not let a slow first load overwrite a newer local write', async () => {
		const repo = createNotesRepository({ now: steppingClock(), sync: spySync() });
		repository = repo;
		const notes = makeStore({ repository: repo });

		// Start the load, then write before it resolves.
		const loading = notes.load();
		const created = await notes.createNote('written during load');
		await loading;

		expect(notes.notes.map((note) => note.id)).toEqual([created.id]);
	});
});

describe('createNote', () => {
	it('adds the note at the top of the list once the write succeeds', async () => {
		const notes = makeStore();
		await notes.load();

		const created = await notes.createNote('hello');

		expect(notes.notes).toEqual([created]);
		expect(notes.status).toBe('ready');
	});

	it('keeps the list sorted when creating several notes', async () => {
		const notes = makeStore();
		const first = await notes.createNote('first');
		const second = await notes.createNote('second');

		expect(notes.notes.map((note) => note.id)).toEqual([second.id, first.id]);
	});

	it('does not touch state and rethrows when the write fails', async () => {
		const repo = createNotesRepository({
			sync: spySync(),
			factory: failingWith('add', 'QuotaExceededError')
		});
		repository = repo;
		const notes = makeStore({ repository: repo });
		await notes.load();
		const before = notes.notes;

		await expect(notes.createNote('too big')).rejects.toBeInstanceOf(StorageFullError);

		expect(notes.notes).toBe(before);
		expect(notes.status).toBe('error');
		expect(notes.error).toBeInstanceOf(StorageFullError);
	});

	it('recovers to ready after a failed write is followed by a successful one', async () => {
		const repo = createNotesRepository({
			sync: spySync(),
			factory: failingWith('add', 'QuotaExceededError')
		});
		const failing = new NotesStore({ repository: repo });
		await failing.load();
		await expect(failing.createNote('nope')).rejects.toBeInstanceOf(StorageFullError);
		expect(failing.status).toBe('error');

		// A fresh store over a healthy database.
		globalThis.indexedDB = new IDBFactory();
		const healthy = createNotesRepository({ now: steppingClock(), sync: spySync() });
		repository = healthy;
		const notes = makeStore({ repository: healthy });
		const created = await notes.createNote('works');

		expect(notes.status).toBe('ready');
		expect(notes.error).toBeNull();
		expect(notes.notes).toEqual([created]);
		failing.dispose();
	});
});

describe('updateNote', () => {
	it('replaces the note and moves it to the top', async () => {
		const notes = makeStore();
		const first = await notes.createNote('first');
		const second = await notes.createNote('second');

		const updated = await notes.updateNote(first.id, 'first edited');

		expect(notes.notes.map((note) => note.id)).toEqual([first.id, second.id]);
		expect(notes.notes[0]).toEqual(updated);
		expect(notes.notes[0].createdAt).toBe(first.createdAt);
		expect(notes.notes[0].body).toBe('first edited');
	});

	it('leaves the list intact when the note disappeared mid-write', async () => {
		const notes = makeStore();
		await notes.createNote('kept');
		const before = notes.notes;

		// #8: this is the shape of "deleted while a save was pending". The record
		// is gone on purpose, so the list is still correct and must not be
		// replaced by an error state; the typed error reaches the caller.
		await expect(notes.updateNote('ghost', 'x')).rejects.toBeInstanceOf(NoteMissingError);

		expect(notes.notes).toBe(before);
		expect(notes.status).toBe('ready');
		expect(notes.error).toBeInstanceOf(NoteMissingError);
	});
});

describe('deleteNote', () => {
	it('removes the note and returns it for Undo', async () => {
		const notes = makeStore();
		const created = await notes.createNote('bye');

		const deleted = await notes.deleteNote(created.id);

		expect(deleted).toEqual(created);
		expect(notes.notes).toEqual([]);
	});

	it('leaves state untouched when the delete fails', async () => {
		const notes = makeStore();
		const created = await notes.createNote('kept');
		const before = notes.notes;

		await expect(notes.deleteNote('ghost')).rejects.toBeInstanceOf(NoteMissingError);

		expect(notes.notes).toBe(before);
		expect(notes.notes).toEqual([created]);
	});
});

describe('restoreNote', () => {
	it('puts the identical note back in its original position', async () => {
		const notes = makeStore();
		const first = await notes.createNote('first');
		const second = await notes.createNote('second');
		const third = await notes.createNote('third');

		const deleted = await notes.deleteNote(second.id);
		await notes.restoreNote(deleted);

		expect(notes.notes.map((note) => note.id)).toEqual([third.id, second.id, first.id]);
		expect(notes.notes[1]).toEqual(deleted);
	});

	it('does not add a duplicate when restoring a note that is already there', async () => {
		const notes = makeStore();
		const created = await notes.createNote('x');

		await notes.restoreNote(created);

		expect(notes.notes).toEqual([created]);
	});

	it('leaves state untouched when the restore fails', async () => {
		const notes = makeStore();
		const created = await notes.createNote('x');
		const deleted = await notes.deleteNote(created.id);
		const invalid = { ...deleted, body: 42 } as unknown as Note;

		await expect(notes.restoreNote(invalid)).rejects.toBeInstanceOf(TypeError);

		expect(notes.notes).toEqual([]);
	});
});

describe('reactive state', () => {
	it('notifies an $effect when notes change', async () => {
		const notes = makeStore();
		await notes.load();
		const observed: number[] = [];
		const probe = probeEffects(() => notes.notes.length, observed);

		await notes.createNote('a');
		await notes.createNote('b');

		expect(observed).toEqual([0, 1, 2]);
		probe.dispose();
	});

	it('notifies an $effect when status changes', async () => {
		const notes = makeStore();
		const observed: NotesStatus[] = [];
		const probe = probeEffects(() => notes.status, observed);

		await notes.load();

		expect(observed).toEqual(['loading', 'ready']);
		probe.dispose();
	});

	it('notifies an $effect when error changes', async () => {
		const repo = createNotesRepository({
			sync: spySync(),
			factory: throwingOpenFactory('SecurityError')
		});
		repository = repo;
		const notes = makeStore({ repository: repo });
		const observed: (Error | null)[] = [];
		const probe = probeEffects(() => notes.error, observed);

		await notes.load();

		expect(observed[0]).toBeNull();
		expect(observed.at(-1)).toBeInstanceOf(StorageUnavailableError);
		probe.dispose();
	});
});

describe('remote changes', () => {
	it('reloads the affected note instead of the whole list', async () => {
		const repo = createNotesRepository({ now: steppingClock(), sync: spySync() });
		repository = repo;
		const sync = spySync();
		const notes = makeStore({ repository: repo, sync });
		const created = await notes.createNote('local version');
		await notes.load();

		// Another tab edits the same note.
		await repo.updateNote(created.id, 'edited elsewhere');
		sync.emit({ type: 'updated', id: created.id });
		await flush();

		expect(notes.notes).toHaveLength(1);
		expect(notes.notes[0].body).toBe('edited elsewhere');
	});

	it('adds a note created in another tab', async () => {
		const repo = createNotesRepository({ now: steppingClock(), sync: spySync() });
		repository = repo;
		const sync = spySync();
		const notes = makeStore({ repository: repo, sync });
		await notes.load();

		const remote = await repo.createNote('from another tab');
		sync.emit({ type: 'created', id: remote.id });
		await flush();

		expect(notes.notes).toEqual([remote]);
	});

	it('drops a note deleted in another tab', async () => {
		const repo = createNotesRepository({ now: steppingClock(), sync: spySync() });
		repository = repo;
		const sync = spySync();
		const notes = makeStore({ repository: repo, sync });
		const created = await notes.createNote('will be deleted');
		await notes.load();

		await repo.deleteNote(created.id);
		sync.emit({ type: 'deleted', id: created.id });
		await flush();

		expect(notes.notes).toEqual([]);
	});

	it('adds a note restored in another tab, in its stored position', async () => {
		const repo = createNotesRepository({ now: steppingClock(), sync: spySync() });
		repository = repo;
		const sync = spySync();
		const notes = makeStore({ repository: repo, sync });
		const first = await notes.createNote('first');
		const second = await notes.createNote('second');
		const third = await notes.createNote('third');
		await notes.load();

		await repo.deleteNote(second.id);
		sync.emit({ type: 'deleted', id: second.id });
		await flush();
		await repo.restoreNote(second);
		sync.emit({ type: 'restored', id: second.id });
		await flush();

		expect(notes.notes.map((note) => note.id)).toEqual([third.id, second.id, first.id]);
	});

	it('ignores a change for a note that no longer exists', async () => {
		const sync = spySync();
		const notes = makeStore({ sync });
		await notes.load();

		sync.emit({ type: 'updated', id: 'never-existed' });
		await flush();

		expect(notes.notes).toEqual([]);
		expect(notes.status).toBe('ready');
	});

	it('reports an error when reloading the note fails', async () => {
		const repo = createNotesRepository({ now: steppingClock(), sync: spySync() });
		repository = repo;
		const created = await repo.createNote('x');
		const sync = spySync();
		// Only `get` fails, so the list load succeeds and the reload does not.
		const failing = new NotesStore({
			repository: createNotesRepository({
				sync: spySync(),
				factory: failingWith('get', 'UnknownError', globalThis.indexedDB)
			}),
			sync
		});
		store?.dispose();
		store = failing;
		await failing.load();
		expect(failing.status).toBe('ready');

		sync.emit({ type: 'updated', id: created.id });
		await flush();

		expect(failing.status).toBe('error');
		expect(failing.error).toBeInstanceOf(StorageCorruptError);
	});

	it('does not let a remote reload clobber a newer local write', async () => {
		const repo = createNotesRepository({ now: steppingClock(), sync: spySync() });
		repository = repo;
		const sync = spySync();
		const notes = makeStore({ repository: repo, sync });
		const created = await notes.createNote('v1');

		// A remote change arrives, and a local write lands before the reload resolves.
		sync.emit({ type: 'updated', id: created.id });
		const updated = await notes.updateNote(created.id, 'local wins');
		await flush();

		expect(notes.notes).toEqual([updated]);
		expect(notes.notes[0].body).toBe('local wins');
	});

	it('converges on the newest committed record (last write wins)', async () => {
		const repo = createNotesRepository({ now: steppingClock(), sync: spySync() });
		repository = repo;
		const sync = spySync();
		const notes = makeStore({ repository: repo, sync });
		const created = await notes.createNote('v1');

		// Two writes to the same note: the later one is what every tab sees.
		await repo.updateNote(created.id, 'from tab A');
		await repo.updateNote(created.id, 'from tab B');
		sync.emit({ type: 'updated', id: created.id });
		await flush();

		expect(notes.notes).toHaveLength(1);
		expect(notes.notes[0].body).toBe('from tab B');
	});
});

describe('dispose', () => {
	it('stops reacting to remote changes', async () => {
		const sync = spySync();
		const notes = makeStore({ sync });
		await notes.load();
		notes.dispose();

		sync.emit({ type: 'created', id: 'a' });
		await flush();

		expect(notes.notes).toEqual([]);
	});

	it('is safe to call twice', () => {
		const notes = makeStore();

		expect(() => {
			notes.dispose();
			notes.dispose();
		}).not.toThrow();
	});
});

describe('normalizeError', () => {
	it('passes typed storage errors through unchanged', () => {
		for (const error of [
			new StorageFullError(),
			new StorageUnavailableError(),
			new StorageCorruptError(),
			new NoteMissingError('x')
		]) {
			expect(normalizeError(error)).toBe(error);
		}
	});

	it('wraps a generic Error as StorageCorruptError, keeping the message', () => {
		const wrapped = normalizeError(new Error('boom'));

		expect(wrapped).toBeInstanceOf(StorageCorruptError);
		expect(wrapped.message).toBe('boom');
	});

	it('wraps a non-Error value', () => {
		const wrapped = normalizeError('not an error');

		expect(wrapped).toBeInstanceOf(StorageCorruptError);
		expect(wrapped.message).toContain('not an error');
	});
});

describe('sync wiring', () => {
	it('uses a real BroadcastChannel by default and announces writes', async () => {
		const remote = new BroadcastChannel('notes-app');
		const seen: RemoteChange[] = [];
		remote.addEventListener('message', (event: MessageEvent) =>
			seen.push(event.data as RemoteChange)
		);
		const notes = makeStore({ sync: undefined });

		const created = await notes.createNote('live');

		const deadline = Date.now() + 2000;
		while (seen.length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(seen).toEqual([{ type: 'created', id: created.id }]);
		remote.close();
	});

	it('creates its own channel when none is injected', () => {
		const notes = makeStore({ sync: undefined });

		expect(notes.repository).toBeDefined();
	});
});

describe('stale result guards', () => {
	it('drops a remote reload that a newer local write superseded', async () => {
		const repo = createNotesRepository({ now: steppingClock(), sync: spySync() });
		repository = repo;
		const created = await repo.createNote('stored');
		const sync = spySync();
		const notes = makeStore({ repository: repo, sync });
		await notes.load();

		// Slow the reload down so a local write can land while it is in flight.
		const slow = Object.create(repo) as NotesRepository;
		const realGet = repo.getNote.bind(repo);
		Object.defineProperty(slow, 'getNote', {
			value: async (id: string) => {
				await new Promise((resolve) => setTimeout(resolve, 30));
				return realGet(id);
			}
		});
		const racing = new NotesStore({ repository: slow, sync });
		store?.dispose();
		store = racing;
		await racing.load();

		sync.emit({ type: 'updated', id: created.id });
		const updated = await racing.updateNote(created.id, 'local');
		await flush();

		expect(racing.notes).toEqual([updated]);
	});

	it('applies a remote delete immediately, before any later local write', async () => {
		const repo = createNotesRepository({ now: steppingClock(), sync: spySync() });
		repository = repo;
		const created = await repo.createNote('stored');
		const sync = spySync();
		const notes = makeStore({ repository: repo, sync });
		await notes.load();

		// A delete is applied synchronously, so it cannot be superseded mid-flight.
		sync.emit({ type: 'deleted', id: created.id });

		expect(notes.notes).toEqual([]);
	});

	it('drops a failed reload that a newer local write superseded', async () => {
		const repo = createNotesRepository({ now: steppingClock(), sync: spySync() });
		repository = repo;
		const created = await repo.createNote('stored');
		const sync = spySync();
		const notes = makeStore({ repository: repo, sync });
		await notes.load();

		const slowFailing = Object.create(repo) as NotesRepository;
		Object.defineProperty(slowFailing, 'getNote', {
			value: async () => {
				await new Promise((resolve) => setTimeout(resolve, 30));
				throw new StorageCorruptError('unreadable');
			}
		});
		const racing = new NotesStore({ repository: slowFailing, sync });
		store?.dispose();
		store = racing;
		await racing.load();

		sync.emit({ type: 'updated', id: created.id });
		const updated = await racing.updateNote(created.id, 'local wins');
		await flush();

		expect(racing.notes).toEqual([updated]);
		expect(racing.status).toBe('ready');
	});

	it('drops a slow failed load that a newer write superseded', async () => {
		const repo = createNotesRepository({ now: steppingClock(), sync: spySync() });
		repository = repo;
		await repo.createNote('already stored');

		const failing = Object.create(repo) as NotesRepository;
		Object.defineProperty(failing, 'listNotes', {
			value: async () => {
				await new Promise((resolve) => setTimeout(resolve, 30));
				throw new StorageCorruptError('unreadable');
			}
		});
		const notes = makeStore({ repository: failing });

		const loading = notes.load();
		const created = await notes.createNote('written during load');
		await loading;

		// The failure belongs to a superseded load: it must not mask the new note.
		expect(notes.notes.map((note) => note.id)).toEqual([created.id]);
		expect(notes.status).toBe('ready');
		expect(notes.error).toBeNull();
	});

	it('drops a slow load that a newer write superseded', async () => {
		const repo = createNotesRepository({ now: steppingClock(), sync: spySync() });
		repository = repo;
		await repo.createNote('already stored');

		const slow = Object.create(repo) as NotesRepository;
		Object.defineProperty(slow, 'listNotes', {
			value: async () => {
				await new Promise((resolve) => setTimeout(resolve, 30));
				return repo.listNotes();
			}
		});
		const notes = makeStore({ repository: slow });

		const loading = notes.load();
		const created = await notes.createNote('written during load');
		await loading;

		expect(notes.notes.map((note) => note.id)).toEqual([created.id]);
	});
});

describe('recovery', () => {
	it('returns to ready after a successful remote reload clears an error', async () => {
		const repo = createNotesRepository({ now: steppingClock(), sync: spySync() });
		repository = repo;
		const created = await repo.createNote('stored');
		const sync = spySync();
		const notes = makeStore({ repository: repo, sync });
		await notes.load();

		// Force an error using a note whose write fails, then let a remote change
		// arrive for a healthy note.
		const broken = Object.create(repo) as NotesRepository;
		Object.defineProperty(broken, 'createNote', {
			value: async () => {
				throw new StorageFullError();
			}
		});
		const recovering = new NotesStore({ repository: broken, sync });
		store?.dispose();
		store = recovering;
		await recovering.load();
		await expect(recovering.createNote('x')).rejects.toBeInstanceOf(StorageFullError);
		expect(recovering.status).toBe('error');

		sync.emit({ type: 'updated', id: created.id });
		await flush();

		expect(recovering.status).toBe('ready');
		expect(recovering.error).toBeNull();
	});

	it('ignores a remote change for a note deleted between the message and the read', async () => {
		const repo = createNotesRepository({ now: steppingClock(), sync: spySync() });
		repository = repo;
		const sync = spySync();
		const notes = makeStore({ repository: repo, sync });
		await notes.load();

		// Not deleted in this tab: the read returns undefined and the note is
		// simply absent, without turning the store into an error state.
		sync.emit({ type: 'updated', id: 'ghost' });
		await flush();

		expect(notes.notes).toEqual([]);
		expect(notes.status).toBe('ready');
	});
});

describe('end-to-end through the store', () => {
	it('create → update → delete → restore round-trips through IndexedDB', async () => {
		const sync = spySync();
		const notes = makeStore({ sync });

		const created = await notes.createNote('# Groceries');
		const updated = await notes.updateNote(created.id, '# Groceries\n- milk');
		expect(updated.createdAt).toBe(created.createdAt);

		const deleted = await notes.deleteNote(created.id);
		expect(notes.notes).toEqual([]);

		await notes.restoreNote(deleted);
		expect(notes.notes).toEqual([updated]);

		// A brand-new store over the same database sees the same data.
		const reloaded = new NotesStore({ repository: createNotesRepository({ sync: spySync() }) });
		await reloaded.load();
		expect(reloaded.notes).toEqual([updated]);
		reloaded.dispose();
		expect(sync.posted.map((change) => change.type)).toEqual([
			'created',
			'updated',
			'deleted',
			'restored'
		]);
	});
});

export { createNotesSync };
