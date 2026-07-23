<script lang="ts">
	import { fade } from 'svelte/transition';
	import type { TrackingState } from '$lib/tracking/tracking.svelte';
	import type { EpisodeCoord } from '$lib/tracking/actions';
	import CheckIcon from '@lucide/svelte/icons/check';

	// The fast path for shows: mark the next unwatched episode without scrolling to the list.
	// Only the "Mark watched" text is interactive; `episodeName` resolves a title from whatever
	// season data the page has loaded (best-effort).
	let {
		tracking,
		episodeName
	}: {
		tracking: TrackingState;
		episodeName?: (season: number, episode: number) => string | undefined;
	} = $props();

	const next = $derived(tracking.nextEpisode());

	// On mark: fill the circle for the just-marked episode, hold briefly, then let the row
	// transition to the new next episode. `frozen` pins the display during that beat.
	let frozen = $state<EpisodeCoord | null>(null);
	let checking = $state(false);
	const shown = $derived(frozen ?? next);
	const name = $derived(shown ? episodeName?.(shown.season, shown.episode) : undefined);

	async function markNext() {
		if (!next || checking) return;
		const target = next;
		checking = true; // fill the circle immediately
		frozen = target; // hold on this episode while the check shows
		await tracking.setEpisodeWatched(target.season, target.episode, true);
		setTimeout(() => {
			frozen = null; // release → row advances to the recomputed next episode
			checking = false;
		}, 650);
	}
</script>

{#if shown}
	<div class="flex w-full items-center gap-3 rounded-xl border border-border bg-secondary/40 p-3">
		<span
			class="flex size-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors {checking
				? 'border-primary bg-primary text-primary-foreground'
				: 'border-primary text-transparent'}"
		>
			<CheckIcon class="size-3.5" />
		</span>
		{#key `${shown.season}:${shown.episode}`}
			<span in:fade={{ duration: 200 }} class="min-w-0 flex-1 text-sm font-medium">
				Next: S{shown.season} · E{shown.episode}{name ? ` · ${name}` : ''}
			</span>
		{/key}
		<button
			type="button"
			onclick={markNext}
			disabled={tracking.busy || checking}
			class="shrink-0 text-sm font-bold text-primary disabled:opacity-60"
		>
			Mark watched
		</button>
	</div>
{/if}
