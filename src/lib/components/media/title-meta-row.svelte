<script lang="ts">
	// Rating, runtime and genres — the row under a title's hero. Shared so the app's title page and a
	// public shared page can't drift apart on what they show or how they lay it out.
	import ClockIcon from '@lucide/svelte/icons/clock';
	import StarIcon from '@lucide/svelte/icons/star';
	import MediaBadge from '$lib/components/media/media-badge.svelte';

	interface Props {
		type: 'movie' | 'show';
		rating: number | null;
		runtime: number | null;
		genres: string[];
	}
	let { type, rating, runtime, genres }: Props = $props();
</script>

<div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
	{#if rating !== null}
		<span class="flex items-center gap-1.5">
			<StarIcon class="size-4 fill-primary text-primary" />
			<span class="font-semibold">{rating.toFixed(1)}</span>
			<span class="text-muted-foreground">/10</span>
		</span>
	{/if}
	{#if runtime !== null}
		<span class="flex items-center gap-1.5 text-muted-foreground">
			<ClockIcon class="size-4" />
			{runtime} min{type === 'show' ? ' / ep' : ''}
		</span>
	{/if}
	{#each genres as genre (genre)}
		<MediaBadge variant="genre">{genre}</MediaBadge>
	{/each}
</div>
