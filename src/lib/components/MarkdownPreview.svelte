<script lang="ts">
	import { cn } from '$lib/utils.js';

	/**
	 * The rendered Markdown preview (#9).
	 *
	 * This component exists so that the sanitized-HTML sink — the app's only
	 * `{@html}` — is one line, in one file, next to the sentence that explains
	 * why it is safe. Everything it renders comes from `renderMarkdown`, whose
	 * output is already sanitized against the allowlist in `$lib/markdown/render`;
	 * no other component may interpolate HTML, and the note itself is only ever
	 * stored as Markdown source.
	 *
	 * `html` is a prop rather than something this component derives from `source`
	 * so the *editor* owns the debounce: the preview re-renders when the editor
	 * says so, which is what keeps rendering off the keystroke path.
	 */
	type Props = {
		/** Sanitized HTML, from `renderMarkdown`. */
		html: string;
		/** Where the scroll container lives, so the caller can style its box. */
		class?: string;
	};

	let { html, class: className }: Props = $props();
</script>

<div
	class={cn(
		// `prose` styles the rendered Markdown; `max-w-none` because the editor pane
		// is the width, not 65ch of it. `prose-invert` in dark mode is inherited
		// from the theme's own `.dark` class (`mode-watcher`), and the typography
		// plugin reads `--tw-prose-*` variables that `prose-invert` remaps.
		'prose max-w-none dark:prose-invert',
		'text-base wrap-anywhere md:text-sm',
		// Long code lines and long URLs must not widen the page: the block scrolls
		// inside itself instead. `prose` already does this for `pre`.
		'[&_.markdown-table-wrap]:max-w-full [&_.markdown-table-wrap]:overflow-x-auto',
		// Images never exceed their column.
		'[&_img]:h-auto [&_img]:max-w-full',
		className
	)}
	data-slot="markdown-preview"
	data-testid="markdown-preview"
>
	<!--
		The only `{@html}` in the app. `html` is the output of `renderMarkdown`,
		which sanitizes against an explicit allowlist (`src/lib/markdown/render.ts`
		and `tests/unit/markdown-render.spec.ts`); nothing unsanitized can reach
		here, and the note is stored as Markdown, never as HTML.
	-->
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized by renderMarkdown -->
	{@html html}
</div>
