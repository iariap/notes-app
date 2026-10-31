<script lang="ts">
	import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import {
		dismissStorageNotice,
		isStorageNoticeDismissed,
		STORAGE_NOTICE_TEXT
	} from '$lib/pwa/storage-notice.js';

	/**
	 * One-time explanation of where the notes live. It is dismissible and the
	 * dismissal is persisted in `localStorage`, so it shows on the first load
	 * only — the check reads the stored flag, never a cached copy of it.
	 *
	 * Placement: mounted between the header and the shell (from
	 * `+layout.svelte`), because the shell is not ours to restructure. The row
	 * reproduces the shell's own geometry — full width below `md`, the same
	 * 320 px sidebar column (`md:w-80` + right border) plus the editor column
	 * from `md` up — so the notice reads as the top of the list on phones and as
	 * the top of the sidebar on wider screens. It never sits in the header, so
	 * the "New note" button keeps its space at every width, and dismissing it
	 * returns the row's height to the list.
	 */
	type Props = {
		onDismiss?: () => void;
	};

	let { onDismiss }: Props = $props();

	let hidden = $state(isStorageNoticeDismissed());

	function dismiss() {
		hidden = true;
		dismissStorageNotice();
		onDismiss?.();
	}
</script>

{#if !hidden}
	<div class="flex shrink-0 border-b border-border" data-testid="storage-notice-row">
		<div
			class="w-full bg-sidebar px-3 py-2 md:w-80 md:shrink-0 md:border-r md:border-border"
			data-testid="storage-notice"
		>
			<Alert class="bg-background">
				<AlertTitle>Your notes stay in this browser</AlertTitle>
				<AlertDescription>
					<p>{STORAGE_NOTICE_TEXT}</p>
					<Button
						variant="outline"
						size="sm"
						class="mt-2 h-11 px-4"
						data-testid="storage-notice-dismiss"
						onclick={dismiss}
					>
						OK, got it
					</Button>
				</AlertDescription>
			</Alert>
		</div>
		<!-- Keeps the row's bottom border running under the editor column. -->
		<div class="hidden flex-1 bg-background md:block" aria-hidden="true"></div>
	</div>
{/if}
