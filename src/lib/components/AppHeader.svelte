<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import type { Snippet } from 'svelte';

	/**
	 * App header: the "Notes" title, the mobile back affordance and a right-hand
	 * region for page actions. The back link is hidden from `md` up, where the
	 * list sidebar replaces it as the way back.
	 */
	type Props = {
		showBack?: boolean;
		actions?: Snippet;
	};

	let { showBack = false, actions }: Props = $props();
</script>

<header
	class="flex shrink-0 items-center gap-1 border-b border-border bg-background px-2"
	style="padding-top: env(safe-area-inset-top); padding-right: calc(0.5rem + env(safe-area-inset-right)); padding-left: calc(0.5rem + env(safe-area-inset-left));"
>
	<div class="flex items-center md:hidden">
		{#if showBack}
			<a
				href={resolve('/')}
				aria-label="Back to notes"
				data-testid="back-to-notes"
				class="inline-flex size-11 items-center justify-center rounded-md text-foreground transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
			>
				<ArrowLeftIcon aria-hidden="true" class="size-5" />
			</a>
		{/if}
	</div>

	<h1 class="min-w-0 px-1 text-base font-semibold tracking-tight">
		<a
			href={resolve('/')}
			class="inline-flex min-h-11 items-center rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			Notes
		</a>
	</h1>

	<div class="ml-auto flex items-center gap-1">
		{@render actions?.()}
	</div>
</header>
