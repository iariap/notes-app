<script lang="ts">
	import './layout.css';
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import StorageNotice from '$lib/components/StorageNotice.svelte';
	import { Toaster } from '$lib/components/ui/sonner/index.js';
	import { NotesStore } from '$lib/notes/notes.svelte';
	import { setNotesStore } from '$lib/notes/store-context';
	import { requestPersistentStorage } from '$lib/pwa/persist.js';
	import { registerServiceWorkerUpdates } from '$lib/pwa/updates.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// Back to the list is a mobile-only affordance: at `md` and up the list
	// sidebar is always on screen, so there is nowhere to go "back" to.
	const showBack = $derived(page.route.id?.startsWith('/notes/') ?? false);

	/**
	 * One store for the whole app, provided through context.
	 *
	 * The list and the editor are on screen together from `md` up, so they must
	 * share this instance: a save in the editor has to move the row in the
	 * sidebar, and a change from another tab has to reach both views. Creating it
	 * here (once, owned by the layout) also means it outlives route changes, so
	 * opening another note reuses the same loaded list instead of re-reading it.
	 *
	 * Guarded by `browser` because the module is imported while building and the
	 * store's constructor opens a `BroadcastChannel`. Context, not a module
	 * singleton, so tests can still mount a route with their own isolated store.
	 */
	const store = browser ? new NotesStore() : null;
	if (store) setNotesStore(store);

	// Browser-only work, once per page load, never during SSR or unit tests
	// (which import this module under jsdom).
	$effect(() => {
		if (!browser) return;
		// Ask the browser to exempt IndexedDB from eviction. Denial is silent:
		// the storage notice already explains what happens if data is cleared.
		void requestPersistentStorage();
		// Announce a waiting service worker as a toast. It never reloads on its
		// own, so nothing is lost while someone is typing.
		registerServiceWorkerUpdates();
	});
</script>

<!--
	No document title here on purpose: each page sets its own (the list, the
	editor and a new note differ). A bare comment instead of an HTML comment
	would render as a text node and offset the whole layout by a line.
-->

<a
	href="#main"
	class="sr-only rounded-md bg-background px-4 py-3 text-sm font-medium focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:ring-2 focus:ring-ring"
	data-testid="skip-link"
>
	Skip to content
</a>

<div
	class="flex h-dvh flex-col overflow-hidden"
	style="padding-bottom: env(safe-area-inset-bottom);"
>
	<AppHeader {showBack} />

	<!--
		Mounted here and not inside the shell: the shell is shared, and this is a
		one-time, layout-level notice. It renders nothing once dismissed.
	-->
	<StorageNotice />

	<main id="main" tabindex="-1" class="flex min-h-0 flex-1 flex-col outline-none">
		{@render children()}
	</main>
</div>

<!-- Mounted once for the whole app: toasts survive route changes. -->
<Toaster />
