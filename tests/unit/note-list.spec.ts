import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import NoteList from '../../src/lib/components/NoteList.svelte';
import { NotesStore } from '$lib/notes/notes.svelte';
import { createNotesRepository, type NotesRepository } from '$lib/notes/repository';
import type { NotesSync } from '$lib/notes/sync';
import { StorageUnavailableError } from '$lib/notes/types';
import { failingWith } from './helpers/failing-idb';
import { throwingOpenFactory } from './helpers/open-failures';

const T0 = Date.parse('2026-10-31T13:13:00.000Z');

/** In-memory sync stub: component tests care about rendering, not the channel. */
function silentSync(): NotesSync {
	return {
		post() {},
		onRemoteChange() {
			return () => {};
		},
		close() {}
	};
}

/**
 * Store whose clock advances one minute per write, so the list order is
 * deterministic (newest first) without waiting on real time.
 */
function steppingStore(startMs = T0): NotesStore {
	let current = startMs;
	return new NotesStore({
		sync: silentSync(),
		now: () => {
			const date = new Date(current);
			current += 60_000;
			return date;
		}
	});
}

let store: NotesStore | undefined;
let repository: NotesRepository | undefined;

/** Rows in DOM order, as the list renders them. */
const renderedRows = () =>
	[...document.querySelectorAll<HTMLAnchorElement>('[data-slot="note-row"]')].map((row) => ({
		id: row.dataset.noteId,
		title: row.querySelector('span')?.textContent?.trim() ?? '',
		text: row.textContent ?? ''
	}));

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
});

afterEach(async () => {
	vi.useRealTimers();
	store?.dispose();
	await store?.repository.close();
	await repository?.close();
	store = undefined;
	repository = undefined;
});

describe('loading state', () => {
	it('renders skeleton rows while the first read is in flight', () => {
		store = steppingStore();
		render(NoteList, { props: { store } });

		expect(screen.getByTestId('note-list-skeleton')).toBeInTheDocument();
		expect(screen.getByRole('status')).toHaveTextContent('Loading notes…');
	});

	it('replaces the skeleton with rows once the read settles', async () => {
		store = steppingStore();
		render(NoteList, { props: { store } });

		await store.createNote('Arrived');

		await screen.findByText('Arrived');
		expect(screen.queryByTestId('note-list-skeleton')).toBeNull();
	});
});

describe('error state', () => {
	it('shows the typed error message in an alert, with no destructive action', async () => {
		const failing = createNotesRepository({
			sync: silentSync(),
			factory: throwingOpenFactory('SecurityError')
		});
		repository = failing;
		store = new NotesStore({ repository: failing });
		render(NoteList, { props: { store } });

		const alert = await screen.findByTestId('note-list-error');
		expect(alert).toHaveAttribute('role', 'alert');
		expect(alert).toHaveTextContent('Notes storage could not be opened');

		// Nothing destructive is offered from an error state: no button at all,
		// and no link that could clear or remove data.
		expect(screen.queryByRole('button')).toBeNull();
		expect(screen.queryByRole('link', { name: /delete|clear|reset|remove|retry/i })).toBeNull();
	});

	it('uses a read failure message verbatim', async () => {
		const failing = createNotesRepository({
			sync: silentSync(),
			factory: failingWith('getAll', 'UnknownError')
		});
		repository = failing;
		store = new NotesStore({ repository: failing });
		render(NoteList, { props: { store } });

		const alert = await screen.findByTestId('note-list-error');
		expect(alert.textContent).toContain('Stored notes could not be read');
	});

	it('surfaces an error that arrives after mount', async () => {
		const failing = createNotesRepository({
			sync: silentSync(),
			factory: failingWith('add', 'QuotaExceededError')
		});
		repository = failing;
		store = new NotesStore({ repository: failing });
		render(NoteList, { props: { store } });

		await expect(store.createNote('too big')).rejects.toBeInstanceOf(Error);

		const alert = await screen.findByTestId('note-list-error');
		expect(alert.textContent).toContain('Storage is full');
	});

	it('does not render an alert when the store is healthy', async () => {
		store = steppingStore();
		render(NoteList, { props: { store } });

		await store.createNote('Fine');

		await screen.findByText('Fine');
		expect(screen.queryByTestId('note-list-error')).toBeNull();
	});
});

describe('empty state', () => {
	it('renders "No notes yet" with a primary "New note" link', async () => {
		store = steppingStore();
		render(NoteList, { props: { store } });

		const empty = await screen.findByTestId('note-list-empty');
		expect(empty).toHaveTextContent('No notes yet');

		const newNote = screen.getByRole('link', { name: 'New note' });
		expect(newNote).toHaveAttribute('href', '/notes/new');
		expect(newNote).toHaveAttribute('data-slot', 'button');
	});

	it('leaves the empty state as soon as the first note exists', async () => {
		store = steppingStore();
		render(NoteList, { props: { store } });

		await screen.findByTestId('note-list-empty');
		await store.createNote('First note');

		await screen.findByText('First note');
		expect(screen.queryByTestId('note-list-empty')).toBeNull();
	});
});

describe('populated state', () => {
	it('renders one row per note in the store order (most recently edited first)', async () => {
		store = steppingStore();
		render(NoteList, { props: { store } });

		await store.createNote('Oldest note');
		await store.createNote('Middle note');
		await store.createNote('Newest note');

		await screen.findByText('Newest note');
		expect(renderedRows().map((row) => row.title)).toEqual([
			'Newest note',
			'Middle note',
			'Oldest note'
		]);
	});

	it('shows the Markdown-stripped title and the preview after the title line', async () => {
		store = steppingStore();
		render(NoteList, { props: { store } });

		await store.createNote('# Groceries\n- [ ] buy milk\n- [x] eggs');

		const row = await screen.findByRole('link', { name: /Groceries/ });
		expect(row).toHaveTextContent('Groceries');
		expect(row).toHaveTextContent('buy milk eggs');
		expect(row.textContent).not.toContain('#');
		expect(row.textContent).not.toContain('[ ]');
	});

	it('shows "Untitled" for a body with no text', async () => {
		store = steppingStore();
		render(NoteList, { props: { store } });

		await store.createNote('   \n\n');

		const row = await screen.findByRole('link', { name: /Untitled/ });
		expect(row).toHaveTextContent('Untitled');
	});

	it('omits the preview row when the note has only a title', async () => {
		store = steppingStore();
		render(NoteList, { props: { store } });

		await store.createNote('Only a title');

		const row = await screen.findByRole('link', { name: /Only a title/ });
		expect(row.querySelectorAll('span')).toHaveLength(1);
		expect(row.querySelector('time')).not.toBeNull();
	});

	it('renders the created date in a <time datetime> with a full-date title', async () => {
		// The list formats against the real clock, so the note must be created at
		// real "now" for the relative label to be deterministic.
		store = new NotesStore({ sync: silentSync() });
		render(NoteList, { props: { store } });

		const created = await store.createNote('Dated note');

		const row = await screen.findByRole('link', { name: /Dated note/ });
		const time = row.querySelector('time');
		expect(time).not.toBeNull();
		expect(time).toHaveAttribute('datetime', created.createdAt);
		expect(time).toHaveTextContent('just now');
		expect(time?.getAttribute('title')).toMatch(/\d{4}/);
		expect(row.dataset.noteId).toBe(created.id);
	});

	it('links each row to /notes/<id>', async () => {
		store = steppingStore();
		render(NoteList, { props: { store } });

		const created = await store.createNote('Linked note');

		const row = await screen.findByRole('link', { name: /Linked note/ });
		expect(row).toHaveAttribute('href', `/notes/${created.id}`);
	});

	it('marks no note as current on the list route', async () => {
		store = steppingStore();
		render(NoteList, { props: { store } });

		await store.createNote('Only note');

		await screen.findByRole('link', { name: /Only note/ });
		expect(screen.queryAllByRole('link', { current: 'page' })).toHaveLength(0);
	});

	it('marks only the note in the URL with aria-current="page"', async () => {
		store = steppingStore();
		const active = await store.createNote('Active note');
		await store.createNote('Other note');
		render(NoteList, { props: { store, activeNoteId: active.id } });

		await screen.findByText('Other note');
		const current = screen.getAllByRole('link', { current: 'page' });
		expect(current).toHaveLength(1);
		expect(current[0]).toHaveAttribute('href', `/notes/${active.id}`);
		expect(current[0]).toHaveClass('bg-accent');
	});

	it('never renders updatedAt: the row has exactly one <time>, the created one', async () => {
		let clock = T0;
		store = new NotesStore({ sync: silentSync(), now: () => new Date(clock) });
		render(NoteList, { props: { store } });

		const created = await store.createNote('Edited later');
		clock += 86_400_000;
		const updated = await store.updateNote(created.id, 'Edited later\nwith more text');

		const row = await screen.findByRole('link', { name: /Edited later/ });
		const times = row.querySelectorAll('time');
		expect(times).toHaveLength(1);
		expect(times[0]).toHaveAttribute('datetime', created.createdAt);
		expect(times[0].getAttribute('datetime')).not.toBe(updated.updatedAt);
		expect(row.textContent).not.toContain('1 day');
		expect(row.textContent).not.toContain('Yesterday');
	});
});

describe('relative dates refresh without a reload', () => {
	it('advances "just now" to a relative label on the minute tick', async () => {
		vi.useFakeTimers({
			toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
		});
		vi.setSystemTime(new Date(T0));

		// The note was created 30 s before the clock the list reads.
		const repo = createNotesRepository({
			sync: silentSync(),
			now: () => new Date(T0 - 30_000)
		});
		repository = repo;
		const created = await repo.createNote('Ticking note');
		store = new NotesStore({ repository: repo, sync: silentSync() });

		render(NoteList, { props: { store } });

		const before = await screen.findByText('just now');
		expect(before.tagName).toBe('TIME');

		// Two minutes later the label must have aged by itself: nothing was
		// reloaded, the store was not touched, only the clock moved.
		vi.setSystemTime(new Date(T0 + 2 * 60_000));
		await vi.advanceTimersByTimeAsync(3 * 60_000);

		await waitFor(() => {
			const time = document.querySelector('time');
			expect(time).not.toBeNull();
			expect(time?.textContent).not.toBe('just now');
			expect(time?.getAttribute('datetime')).toBe(created.createdAt);
		});
		expect(document.querySelector('time')?.textContent).toMatch(/minutes ago/);
	});
});

describe('store ownership', () => {
	it('does not close a store it does not own', async () => {
		const repo = createNotesRepository({ sync: silentSync() });
		repository = repo;
		store = new NotesStore({ repository: repo });
		const close = vi.spyOn(repo, 'close');

		const { unmount } = render(NoteList, { props: { store } });
		await screen.findByTestId('note-list-empty');
		unmount();

		expect(close).not.toHaveBeenCalled();
	});

	it('loads a store the caller has not loaded yet', async () => {
		const repo = createNotesRepository({ sync: silentSync(), now: () => new Date(T0) });
		repository = repo;
		await repo.createNote('Stored before mount');
		store = new NotesStore({ repository: repo });
		const load = vi.spyOn(store, 'load');

		render(NoteList, { props: { store } });

		await screen.findByText('Stored before mount');
		expect(load).toHaveBeenCalled();
	});

	it('reports a typed unavailable error from a pre-loaded store', async () => {
		const failing = createNotesRepository({
			sync: silentSync(),
			factory: throwingOpenFactory('InvalidStateError')
		});
		repository = failing;
		store = new NotesStore({ repository: failing });
		await store.load();

		expect(store.error).toBeInstanceOf(StorageUnavailableError);
		render(NoteList, { props: { store } });

		const alert = await screen.findByTestId('note-list-error');
		expect(alert).toHaveTextContent('Notes storage could not be opened');
	});
});
