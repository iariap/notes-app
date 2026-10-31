<script lang="ts">
	import { page } from '$app/state';
	import AppShell from '$lib/components/AppShell.svelte';
	import NoteEditor from '$lib/components/NoteEditor.svelte';
	import NoteList from '$lib/components/NoteList.svelte';

	/**
	 * `page.params.id` is the note in the URL.
	 *
	 * The editor is keyed by it because one editor instance owns exactly one
	 * note: switching notes is a different instance, and the old one flushes (or
	 * discards an emptied note) on destroy. Creating a note never changes this
	 * route's params — `replaceState` is a shallow history update — so the editor
	 * is not remounted by the URL change on `/notes/new`.
	 */
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
		{#key noteId}
			<NoteEditor {noteId} />
		{/key}
	{/snippet}
</AppShell>
