<script lang="ts">
	import { resolve } from '$app/paths';
	import { cn } from '$lib/utils.js';

	/**
	 * Static stand-in for the notes list (#6 replaces this file with the
	 * storage-backed list). It exists now so the shell's active-note treatment
	 * (`aria-current="page"`) is real and testable; it never reads storage.
	 */
	const placeholderNotes = [
		{ id: 'some-id', label: 'Placeholder note 1' },
		{ id: 'another-note', label: 'Placeholder note 2' },
		{ id: 'third-note', label: 'Placeholder note 3' }
	];

	type Props = {
		activeNoteId?: string | null;
	};

	let { activeNoteId = null }: Props = $props();
</script>

<div class="flex flex-col gap-4 p-4" data-placeholder="note-list">
	<div class="flex flex-col gap-1">
		<h2 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
			Notes list placeholder
		</h2>
		<p class="text-sm text-muted-foreground">The real list with storage arrives in #6.</p>
	</div>

	<ul class="flex flex-col gap-1">
		{#each placeholderNotes as note (note.id)}
			{@const isActive = note.id === activeNoteId}
			<li>
				<a
					href={resolve('/notes/[id]', { id: note.id })}
					aria-current={isActive ? 'page' : undefined}
					class={cn(
						'flex min-h-11 flex-col justify-center gap-0.5 rounded-md px-3 py-2 text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
						isActive && 'bg-accent'
					)}
				>
					<span class={isActive ? 'font-semibold text-accent-foreground' : 'font-medium'}>
						{note.label}
					</span>
					<!--
						`muted-foreground` on `bg-accent` lands at ~4.34:1, under WCAG AA for
						body text, so the active row uses a stronger foreground instead.
					-->
					<span class={isActive ? 'text-accent-foreground/80' : 'text-muted-foreground'}>
						Placeholder preview
					</span>
				</a>
			</li>
		{/each}
	</ul>
</div>
