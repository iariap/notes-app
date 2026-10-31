<script lang="ts">
	import { cn } from '$lib/utils.js';

	/**
	 * What the editor pane shows when no note is open: `/` at `md` and up (the
	 * list has the single mobile column there, so this pane is not on screen).
	 */
</script>

<div
	class={cn('flex min-h-full flex-col items-center justify-center gap-2 p-6 text-center')}
	data-placeholder="editor-hint"
>
	<p class="text-base font-medium">Select a note or create a new one</p>
	<p class="text-sm text-muted-foreground">Your notes are saved as you type.</p>
</div>
