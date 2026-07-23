<script lang="ts">
	import type { TrackingState } from '$lib/tracking/tracking.svelte';
	import type { SeasonCounts } from '$lib/tracking/actions';
	import CircleIcon from '@lucide/svelte/icons/circle';

	// The fast path for shows: mark the next unwatched episode without scrolling to the list.
	// `episodeName` resolves a title from whatever season data the page has loaded (best-effort).
	let {
		tracking,
		seasons,
		episodeName
	}: {
		tracking: TrackingState;
		seasons: SeasonCounts[];
		episodeName?: (season: number, episode: number) => string | undefined;
	} = $props();

	const next = $derived(tracking.nextEpisode(seasons));
	const name = $derived(next ? episodeName?.(next.season, next.episode) : undefined);
</script>

{#if next}
	<button
		type="button"
		onclick={() => tracking.setEpisodeWatched(next.season, next.episode, true)}
		disabled={tracking.busy}
		class="flex w-full items-center gap-3 rounded-xl border border-border bg-secondary/40 p-3 text-left disabled:opacity-60"
	>
		<CircleIcon class="size-6 shrink-0 text-primary" />
		<span class="min-w-0 flex-1 text-sm font-medium">
			Next: S{next.season} · E{next.episode}{name ? ` · ${name}` : ''}
		</span>
		<span class="shrink-0 text-sm font-bold text-primary">Mark watched</span>
	</button>
{/if}
