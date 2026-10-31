<script lang="ts">
	import AppShell from '$lib/components/AppShell.svelte';
	import NoteEditor from '$lib/components/NoteEditor.svelte';
	import NoteList from '$lib/components/NoteList.svelte';

	/**
	 * A new note has no id yet.
	 *
	 * The editor rewrites the URL to `/notes/<id>` with `replaceState` on the
	 * first non-whitespace character — the same history entry and *not* a
	 * navigation, so this component (and the editor's caret) keeps running.
	 * `createdId` is how the sidebar learns the new note's id in the meantime:
	 * `page.params` does not change on a shallow history update.
	 */
	let createdId = $state<string | null>(null);
</script>

<svelte:head>
	<title>New note · Notes</title>
</svelte:head>

<AppShell mobilePane="editor">
	{#snippet list()}
		<NoteList activeNoteId={createdId} />
	{/snippet}

	{#snippet editor()}
		<NoteEditor noteId={null} onCreated={(id) => (createdId = id)} />
	{/snippet}
</AppShell>
