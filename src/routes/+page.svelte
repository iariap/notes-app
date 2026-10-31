<script lang="ts">
	import AppShell from '$lib/components/AppShell.svelte';
	import EditorPlaceholder from '$lib/components/EditorPlaceholder.svelte';
	import NoteList from '$lib/components/NoteList.svelte';
</script>

<svelte:head>
	<title>Notes</title>
	<meta
		name="description"
		content="Notes — a local-first notes app that runs entirely in your browser."
	/>
</svelte:head>

<AppShell mobilePane="list">
	{#snippet list()}
		<NoteList />
	{/snippet}

	{#snippet editor()}
		<EditorPlaceholder mode="empty" />
	{/snippet}
</AppShell>
