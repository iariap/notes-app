<script lang="ts">
	import './layout.css';
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import StorageNotice from '$lib/components/StorageNotice.svelte';
	import { Toaster } from '$lib/components/ui/sonner/index.js';
	import { requestPersistentStorage } from '$lib/pwa/persist.js';
	import { registerServiceWorkerUpdates } from '$lib/pwa/updates.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// Back to the list is a mobile-only affordance: at `md` and up the list
	// sidebar is always on screen, so there is nowhere to go "back" to.
	const showBack = $derived(page.route.id?.startsWith('/notes/') ?? false);

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
