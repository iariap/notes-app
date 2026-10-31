<script lang="ts">
	import { page } from '$app/state';
	import AppShell from '$lib/components/AppShell.svelte';
	import EditorPlaceholder from '$lib/components/EditorPlaceholder.svelte';
	import NoteList from '$lib/components/NoteList.svelte';

	const noteId = $derived(page.params.id ?? null);
</script>

<svelte:head>
	<title>Note · Notes</title>
</svelte:head>

<AppShell mobilePane="editor">
	{#snippet list()}
		<NoteList activeNoteId={noteId} />
	{/snippet}

	{#snippet editor()}
		<EditorPlaceholder mode="note" {noteId} />
	{/snippet}
</AppShell>
