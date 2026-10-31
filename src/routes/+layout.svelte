<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import { Toaster } from '$lib/components/ui/sonner/index.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// Back to the list is a mobile-only affordance: at `md` and up the list
	// sidebar is always on screen, so there is nowhere to go "back" to.
	const showBack = $derived(page.route.id?.startsWith('/notes/') ?? false);
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

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

	<main id="main" tabindex="-1" class="flex min-h-0 flex-1 flex-col outline-none">
		{@render children()}
	</main>
</div>

<!-- Mounted once for the whole app: toasts survive route changes. -->
<Toaster />
