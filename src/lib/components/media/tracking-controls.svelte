<script lang="ts">
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import ConfirmDialog from './confirm-dialog.svelte';
	import MediaBadge from './media-badge.svelte';
	import type { TrackingState } from '$lib/tracking/tracking.svelte';
	import CheckIcon from '@lucide/svelte/icons/check';
	import HeartIcon from '@lucide/svelte/icons/heart';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';

	// Shared tracking action row for the detail page. For a show, "mark watched" marks the whole
	// series (confirmed, since it's hard to undo) — the season list lives on `tracking`.
	let { tracking, type }: { tracking: TrackingState; type: 'movie' | 'show' } = $props();

	let removeOpen = $state(false);
	let markSeriesOpen = $state(false);

	const view = $derived(tracking.view);
	const done = $derived(view.tracked && view.status === 'completed');
	const favorite = $derived(view.tracked && view.favorite);
	// Status is conveyed by the buttons (add / mark watched / watched). Only "didn't finish" —
	// which the buttons can't express — gets an explicit label below them.
	const didNotFinish = $derived(view.tracked && view.status === 'did_not_finish');

	function markWatched() {
		if (done) {
			tracking.setStatus('want_to_watch'); // revert; leaves episode history intact
		} else if (type === 'show') {
			markSeriesOpen = true; // confirm — marks every episode watched
		} else {
			tracking.setStatus('completed');
		}
	}

	function chooseDidNotFinish() {
		tracking.setStatus('did_not_finish').then(() => (removeOpen = false));
	}
</script>

<div class="flex flex-col gap-1.5">
	<div class="flex flex-wrap items-center gap-2">
		{#if !view.tracked}
			<Button
				onclick={() => tracking.add()}
				disabled={!tracking.ready || tracking.busy}
				class="gap-1.5"
			>
				<PlusIcon class="size-4" />
				Add to list
			</Button>
		{:else}
			<Button
				variant={done ? 'secondary' : 'default'}
				onclick={markWatched}
				disabled={tracking.busy}
				class="gap-1.5"
			>
				<CheckIcon class="size-4" />
				{done ? 'Watched' : type === 'show' ? 'Mark series watched' : 'Mark watched'}
			</Button>
			<Button
				variant="outline"
				size="icon"
				onclick={() => (removeOpen = true)}
				disabled={tracking.busy}
				aria-label="Remove from list"
				title="Remove"
			>
				<XIcon class="size-4" />
			</Button>
			<Button
				variant="ghost"
				size="icon"
				onclick={() => tracking.toggleFavorite()}
				disabled={tracking.busy}
				aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
				aria-pressed={favorite}
				title="Favorite"
			>
				<HeartIcon class="size-5 {favorite ? 'fill-primary text-primary' : ''}" />
			</Button>
		{/if}
	</div>
	{#if didNotFinish}
		<MediaBadge variant="status" class="self-start">Didn't finish</MediaBadge>
	{/if}
</div>

<!-- Remove: destructive, or keep as "didn't finish", or cancel -->
<Dialog.Root bind:open={removeOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Remove from your list?</Dialog.Title>
			<Dialog.Description>
				You can remove this title entirely, or keep it as didn't finish.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer class="gap-2 sm:flex-col sm:gap-2">
			<Button
				variant="destructive"
				onclick={() => tracking.remove().then(() => (removeOpen = false))}
				disabled={tracking.busy}
			>
				Remove
			</Button>
			<Button variant="outline" onclick={chooseDidNotFinish} disabled={tracking.busy}>
				Mark as didn't finish
			</Button>
			<Dialog.Close class={buttonVariants({ variant: 'ghost' })}>Cancel</Dialog.Close>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={markSeriesOpen}
	title="Mark the whole series as watched?"
	description="This marks every episode of every season watched. You can't easily undo it."
	confirmLabel="Mark series watched"
	busy={tracking.busy}
	onconfirm={() => tracking.markSeriesWatched().then(() => (markSeriesOpen = false))}
/>
