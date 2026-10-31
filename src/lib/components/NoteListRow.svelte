<script lang="ts">
	import { resolve } from '$app/paths';
	import { Tooltip as TooltipPrimitive } from 'bits-ui';
	import { formatCreatedDate, formatFullDate } from '$lib/notes/date';
	import type { Note } from '$lib/notes/types';
	import { cn } from '$lib/utils.js';

	/**
	 * One row of the notes list: title, preview and created date, all inside a
	 * single link to the note.
	 *
	 * The link is also the tooltip trigger, so there is exactly **one**
	 * interactive element per row — a tooltip button nested inside the link would
	 * be invalid HTML and a keyboard trap, and a focusable `<time>` inside the
	 * link is the same problem with extra steps. bits-ui adds
	 * `aria-describedby` to the trigger while the tooltip is open, which is what
	 * makes the full date reach screen-reader users, and `title` covers the
	 * native (no-JS, no-focus) case.
	 *
	 * The trigger joins the list's single shared tether instead of owning a
	 * `Tooltip` root: a root per row costs ~85 ms of first render per 1,000 rows,
	 * because each one builds a presence manager, a timer and three watchers.
	 */
	type Props = {
		note: Note;
		title: string;
		preview: string;
		active?: boolean;
		/** The shared clock, so every relative label ages in the same tick. */
		now: Date;
		/** The list's single tooltip tether; the row only contributes a trigger. */
		tether: TooltipPrimitive.Tether<string>;
	};

	let { note, title, preview, active = false, now, tether }: Props = $props();

	const createdLabel = $derived(formatCreatedDate(note.createdAt, now));
	const fullDate = $derived(formatFullDate(note.createdAt));
</script>

{#snippet row({ props }: { props: Record<string, unknown> })}
	<!--
		`muted-foreground` on `bg-accent` lands at ~4.34:1, under WCAG AA for
		body text, so the active row uses a stronger foreground instead (same
		call #5 made for the shell's rows).
	-->
	<a
		{...props}
		href={resolve('/notes/[id]', { id: note.id })}
		aria-current={active ? 'page' : undefined}
		data-slot="note-row"
		data-note-id={note.id}
		class={cn(
			'flex min-h-11 flex-col justify-center gap-0.5 rounded-md px-3 py-2 transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
			active && 'bg-accent'
		)}
	>
		<span
			class={cn(
				'truncate text-sm',
				active ? 'font-semibold text-accent-foreground' : 'font-medium'
			)}>{title}</span
		>
		{#if preview}
			<span
				class={cn(
					'line-clamp-2 text-sm',
					active ? 'text-accent-foreground/80' : 'text-muted-foreground'
				)}>{preview}</span
			>
		{/if}
		<time
			datetime={note.createdAt}
			title={fullDate}
			data-slot="note-row-date"
			class={cn('mt-0.5 text-xs', active ? 'text-accent-foreground/80' : 'text-muted-foreground')}
			>{createdLabel}</time
		>
	</a>
{/snippet}

<TooltipPrimitive.Trigger {tether} payload={fullDate} child={row} />
