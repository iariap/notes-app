<script lang="ts">
	import AppShell from '$lib/components/AppShell.svelte';
	import EditorPlaceholder from '$lib/components/EditorPlaceholder.svelte';
	import NoteListPlaceholder from '$lib/components/NoteListPlaceholder.svelte';
</script>

<svelte:head>
	<title>New note · Notes</title>
</svelte:head>

<!-- A new note has no id yet, so nothing in the list is the "current" note. -->
<AppShell mobilePane="editor">
	{#snippet list()}
		<NoteListPlaceholder />
	{/snippet}

	{#snippet editor()}
		<EditorPlaceholder mode="note" noteId={null} />
	{/snippet}
</AppShell>
