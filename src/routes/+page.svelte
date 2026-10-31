<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
</script>

<svelte:head>
	<title>Notes</title>
	<meta
		name="description"
		content="Notes — a local-first notes app that runs entirely in your browser."
	/>
</svelte:head>

<main class="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10 text-center">
	<div class="space-y-2">
		<p class="text-sm font-medium text-muted-foreground">Local-first notes</p>
		<h1 class="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">Notes</h1>
		<p class="max-w-prose text-sm text-muted-foreground">
			Your notes live in this browser. Nothing is uploaded anywhere.
		</p>
	</div>
	<Button size="lg">New note</Button>
</main>
