<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
	import { cn } from '$lib/utils.js';

	/**
	 * The single responsive frame every route lives in. Which pane is visible is
	 * decided purely by CSS breakpoints (Tailwind `md`, 768 px) — never by user
	 * agent or JS viewport sniffing.
	 *
	 * `mobilePane` only picks which pane owns the single column below `md`; from
	 * `md` up both panes are always visible side by side.
	 */
	type Props = {
		mobilePane: 'list' | 'editor';
		list: Snippet;
		editor: Snippet;
	};

	let { mobilePane, list, editor }: Props = $props();
</script>

<div class="flex min-h-0 w-full flex-1 overflow-hidden" data-slot="app-shell">
	<section
		aria-label="Notes"
		data-pane="list"
		class={cn(
			'min-h-0 w-full shrink-0 flex-col bg-sidebar md:flex md:w-80 md:border-r md:border-border',
			mobilePane === 'list' ? 'flex' : 'hidden'
		)}
	>
		<ScrollArea class="min-h-0 flex-1">
			{@render list()}
		</ScrollArea>
	</section>

	<section
		aria-label="Note editor"
		data-pane="editor"
		class={cn(
			'min-h-0 min-w-0 flex-1 flex-col bg-background md:flex',
			mobilePane === 'editor' ? 'flex' : 'hidden'
		)}
	>
		<ScrollArea class="min-h-0 flex-1">
			{@render editor()}
		</ScrollArea>
	</section>
</div>
