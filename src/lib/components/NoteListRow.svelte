<script lang="ts">
	import { resolve } from '$app/paths';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { Tooltip as TooltipPrimitive } from 'bits-ui';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuTrigger
	} from '$lib/components/ui/dropdown-menu/index.js';
	import { formatCreatedDate, formatFullDate } from '$lib/notes/date';
	import type { Note } from '$lib/notes/types';
	import { cn } from '$lib/utils.js';

	/**
	 * One row of the notes list: title, preview and created date, all inside a
	 * single link to the note, plus a "⋯" menu to delete it (#8).
	 *
	 * The link is the tooltip trigger, so the full date keeps reaching
	 * screen-reader users (bits-ui adds `aria-describedby` while it is open) and
	 * `title` covers the native case. The trigger joins the list's single shared
	 * tether instead of owning a `Tooltip` root: a root per row costs ~85 ms of
	 * first render per 1,000 rows, because each one builds a presence manager, a
	 * timer and three watchers.
	 *
	 * The menu is the second interactive element in the row, and it is a
	 * **sibling** of the link, not a child: a `<button>` inside an `<a>` is
	 * invalid HTML and unusable from a keyboard. It sits in the row's corner, so
	 * the title and preview get a right gutter to stay clear of it.
	 *
	 * Visibility follows the pointing device: always on screen where the pointer
	 * is coarse (a finger has no hover), and on hover or keyboard focus
	 * otherwise. `opacity` — not `hidden` — keeps it in the tab order, so
	 * `focus-within` is what reveals it to a keyboard user. The 44 px box is
	 * unchanged in both cases: only the paint is conditional.
	 *
	 * **The menu root is mounted on first use, not on render.** A `DropdownMenu`
	 * root is the same class of cost as a `Tooltip` root — measured on the 1,000
	 * note perf spec, one root per row moved the marginal first render from
	 * 87 ms to 287 ms — and only one row is ever being used at a time. Until its
	 * trigger is pressed, a row renders a plain button with the same name, box
	 * and attributes; the press mounts the menu already open, so nothing about
	 * the interaction changes.
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
		/** Deletes this note through the list's one handler (never per row). */
		onDelete?: (id: string) => void;
	};

	let { note, title, preview, active = false, now, tether, onDelete }: Props = $props();

	const createdLabel = $derived(formatCreatedDate(note.createdAt, now));
	const fullDate = $derived(formatFullDate(note.createdAt));

	/** The menu root exists only once this row's menu has been asked for. */
	let menuMounted = $state(false);
	let menuOpen = $state(false);

	/** Shared by the placeholder button and the real trigger, so the swap is invisible. */
	const triggerClass =
		'inline-flex size-11 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring';
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
			'flex min-h-11 flex-col justify-center gap-0.5 rounded-md py-2 pr-12 pl-3 transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
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

<div class="group/row relative min-w-0" data-slot="note-row-wrapper" data-note-id={note.id}>
	<TooltipPrimitive.Trigger {tether} payload={fullDate} child={row} />

	<div
		class="absolute top-1/2 right-0 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100"
	>
		{#if menuMounted}
			<DropdownMenu bind:open={menuOpen}>
				<DropdownMenuTrigger
					aria-label="Note actions"
					data-testid="note-row-menu"
					data-note-id={note.id}
					class={triggerClass}
				>
					<span aria-hidden="true" class="text-lg leading-none">⋯</span>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					onCloseAutoFocus={(event) => {
						// Deleting removes the row, trigger included, so the menu's default
						// "put focus back on the trigger" would land on a detached node and
						// drop the user's focus to `<body>`. The list decides where focus
						// goes instead (the neighbouring row), right after the delete.
						if (onDelete) event.preventDefault();
					}}
				>
					<DropdownMenuItem
						variant="destructive"
						data-testid="note-row-delete"
						onSelect={() => onDelete?.(note.id)}
					>
						<Trash2Icon aria-hidden="true" />
						Delete
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		{:else}
			<button
				type="button"
				aria-label="Note actions"
				aria-haspopup="menu"
				data-testid="note-row-menu"
				data-note-id={note.id}
				class={triggerClass}
				onclick={() => {
					// Mount and open in the same turn: the menu appears where the
					// trigger already was, so the press behaves like any other menu.
					menuMounted = true;
					menuOpen = true;
				}}
			>
				<!--
					A text glyph, not the lucide icon: an inline SVG per row is three
					more nodes (and a component instance) multiplied by the note count,
					which the perf spec measures. Only the mounted menu — one row at a
					time — pays for the icon.
				-->
				<span aria-hidden="true" class="text-lg leading-none">⋯</span>
			</button>
		{/if}
	</div>
</div>
