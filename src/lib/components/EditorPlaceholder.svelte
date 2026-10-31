<script lang="ts">
	import { cn } from '$lib/utils.js';

	/**
	 * Static stand-in for the note editor (#7 replaces this file). `mode` is
	 * `'empty'` when no note is selected (`/` at `md` and up), otherwise it
	 * reflects the id in the URL.
	 */
	type Props = {
		mode: 'empty' | 'note';
		noteId?: string | null;
	};

	let { mode, noteId = null }: Props = $props();
</script>

{#if mode === 'empty'}
	<div
		class="flex min-h-full flex-col items-center justify-center gap-2 p-6 text-center"
		data-placeholder="editor-hint"
	>
		<p class="text-base font-medium">Select a note or create a new one</p>
		<p class="text-sm text-muted-foreground">Placeholder — the editor arrives in #7.</p>
	</div>
{:else}
	<div class={cn('flex min-h-full flex-col gap-4 p-4')} data-placeholder="editor">
		<div class="flex flex-col gap-1">
			<h2 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Editor</h2>
			<p class="text-sm text-muted-foreground">
				Placeholder for note <code class="font-mono text-xs">{noteId ?? '(new note)'}</code> — the real
				editor arrives in #7.
			</p>
		</div>

		<div
			class="flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground"
		>
			<p>The note body will be editable here.</p>
			<p>Nothing is saved yet: these placeholders never touch storage.</p>
		</div>
	</div>
{/if}
