<script lang="ts">
	import { fade } from 'svelte/transition';
	import { Button } from '$lib/components/ui/button';
	import type { TrackingState } from '$lib/tracking/tracking.svelte';
	import type { EpisodeCoord } from '$lib/tracking/actions';
	import CheckIcon from '@lucide/svelte/icons/check';

	// The fast path for shows: mark the next unwatched episode without scrolling to the list.
	// `episodeName` resolves a title from whatever season data the page has loaded (best-effort).
	interface Props {
		tracking: TrackingState;
		episodeName?: (season: number, episode: number) => string | undefined;
	}
	let { tracking, episodeName }: Props = $props();

	const next = $derived(tracking.nextEpisode());

	// On mark: fill the circle for the just-marked episode, hold briefly (`frozen` pins the
	// display), then release so the row transitions to the recomputed next episode.
	let frozen = $state<EpisodeCoord | null>(null);
	let checking = $state(false);
	const shown = $derived(frozen ?? next);
	const name = $derived(shown ? episodeName?.(shown.season, shown.episode) : undefined);

	async function markNext() {
		if (!next || checking) return;
		const target = next;
		checking = true;
		frozen = target;
		await tracking.setEpisodeWatched(target.season, target.episode, true);
		setTimeout(() => {
			frozen = null;
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
		<Button
			variant="ghost"
			size="sm"
			onclick={markNext}
			disabled={tracking.busy || checking}
			class="shrink-0 font-bold text-primary"
		>
			Mark watched
		</Button>
	</div>
{/if}
