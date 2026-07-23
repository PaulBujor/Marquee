<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { recordEvent, getTrackingByMediaId } from '$lib/client/idb';
	import {
		nextFavorite,
		statusEventType,
		toTrackingView,
		type TrackingView
	} from '$lib/tracking/actions';
	import type { TrackingStatus } from '$lib/sync/events';
	import CheckIcon from '@lucide/svelte/icons/check';
	import HeartIcon from '@lucide/svelte/icons/heart';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';

	// The title's media id (`tmdbMediaId(type, tmdbId)`) — the aggregate every event targets.
	let { mediaId }: { mediaId: string } = $props();

	// Local tracking state is client-only (IndexedDB), so it loads after mount; until then the
	// controls render disabled to avoid an SSR/client flash of the wrong state.
	let view = $state<TrackingView>({ tracked: false });
	let ready = $state(false);
	let busy = $state(false);
	let removeOpen = $state(false);

	async function refresh() {
		view = toTrackingView(await getTrackingByMediaId(mediaId));
	}

	onMount(async () => {
		await refresh();
		ready = true;
	});

	/** Set (or, on an untracked title, add with) a status. */
	async function setStatus(status: TrackingStatus) {
		busy = true;
		try {
			if (statusEventType(view) === 'tracking.added') {
				await recordEvent('tracking.added', mediaId, { status });
			} else {
				await recordEvent('tracking.status_changed', mediaId, { status });
			}
			await refresh();
		} finally {
			busy = false;
		}
	}

	async function toggleFavorite() {
		busy = true;
		try {
			await recordEvent('tracking.favorite_toggled', mediaId, { favorite: nextFavorite(view) });
			await refresh();
		} finally {
			busy = false;
		}
	}

	async function remove() {
		busy = true;
		try {
			await recordEvent('tracking.removed', mediaId, {});
			await refresh();
			removeOpen = false;
		} finally {
			busy = false;
		}
	}

	// The primary button reflects the current state: add → mark watched → (revert). `did_not_finish`
	// and `completed` read as "done" states reachable from the remove dialog / the watched toggle.
	const done = $derived(view.tracked && view.status === 'completed');
	const favorite = $derived(view.tracked && view.favorite);
</script>

<div class="flex items-center gap-2">
	{#if !view.tracked}
		<Button onclick={() => setStatus('want_to_watch')} disabled={!ready || busy} class="gap-1.5">
			<PlusIcon class="size-4" />
			Want to Watch
		</Button>
	{:else}
		<Button
			variant={done ? 'secondary' : 'default'}
			onclick={() => setStatus(done ? 'want_to_watch' : 'completed')}
			disabled={busy}
			class="gap-1.5"
		>
			<CheckIcon class="size-4" />
			{done ? 'Watched' : 'Mark Watched'}
		</Button>
		<Button
			variant="outline"
			size="icon"
			onclick={() => (removeOpen = true)}
			disabled={busy}
			aria-label="Remove from watchlist"
			title="Remove"
		>
			<XIcon class="size-4" />
		</Button>
	{/if}

	<Button
		variant="ghost"
		size="icon"
		onclick={toggleFavorite}
		disabled={!ready || busy}
		aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
		aria-pressed={favorite}
		title="Favorite"
	>
		<HeartIcon class="size-5 {favorite ? 'fill-primary text-primary' : ''}" />
	</Button>
</div>

<Dialog.Root bind:open={removeOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Remove from your list?</Dialog.Title>
			<Dialog.Description>
				You can remove this title entirely, or keep it as didn't finish.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer class="gap-2 sm:flex-col sm:gap-2">
			<Button variant="destructive" onclick={remove} disabled={busy}>Remove</Button>
			<Button
				variant="outline"
				onclick={() => setStatus('did_not_finish').then(() => (removeOpen = false))}
				disabled={busy}
			>
				Mark as didn't finish
			</Button>
			<Dialog.Close class={buttonVariants({ variant: 'ghost' })}>Cancel</Dialog.Close>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
