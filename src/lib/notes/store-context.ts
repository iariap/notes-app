/**
 * The one `NotesStore` the app runs on.
 *
 * The list and the editor are two views of the same data and are on screen
 * together from `md` up, so they must read the *same* instance: a save in the
 * editor has to move the row in the sidebar, and a change from another tab has
 * to reach both. Before this, each route mounted its own store (#6 kept the
 * sidebar and `aria-current` truthful that way), which worked only because no
 * screen had two writers.
 *
 * The store is provided once by `+layout.svelte` through Svelte context, which
 * keeps it a per-mount value rather than a module singleton: a test (or a
 * future route that wants its own data) can provide an isolated instance
 * without touching global state, and the store is disposed with the layout.
 */
import { getContext, setContext } from 'svelte';
import type { NotesStore } from './notes.svelte';

const NOTES_STORE_KEY = Symbol('notes-store');

/** Provides `store` to every descendant of the calling component. */
export function setNotesStore(store: NotesStore): NotesStore {
	setContext(NOTES_STORE_KEY, store);
	return store;
}

/**
 * The context a route needs when it is mounted *without* the layout — i.e. a
 * component test that renders one route in isolation. Production always gets
 * the store from `+layout.svelte`; this is the same key, not a second path.
 */
export function notesStoreContext(store: NotesStore): Map<unknown, unknown> {
	return new Map<unknown, unknown>([[NOTES_STORE_KEY, store]]);
}

/**
 * The store provided by the layout. Throws instead of creating a fallback:
 * a second instance is exactly the bug this module exists to prevent, and a
 * silent one would only show up as a sidebar that ignores saves.
 */
export function getNotesStore(): NotesStore {
	const store = getContext<NotesStore | undefined>(NOTES_STORE_KEY);
	if (store === undefined) {
		throw new Error(
			'No notes store in context. Render this component under the app layout (which calls setNotesStore), or in a test wrap it in the store provider helper.'
		);
	}
	return store;
}
