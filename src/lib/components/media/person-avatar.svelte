<script lang="ts">
	import { cn } from '$lib/utils.js';
	import { posterUrl, type TmdbImageSize } from '$lib/media.js';

	/**
	 * A person's circular profile photo, falling back to their initials. Profile images come straight
	 * from TMDB rather than through `MediaImage` — people aren't part of the offline media cache.
	 */
	interface Props {
		name: string;
		profilePath: string | null;
		size?: TmdbImageSize;
		/** Sizing classes for the circle (e.g. `size-14`) — the caller owns the scale. */
		class?: string;
	}
	let { name, profilePath, size = 'w185', class: className }: Props = $props();

	const src = $derived(posterUrl(profilePath, size));

	/** First letters of the first two words — e.g. "Christopher Nolan" → "CN". */
	const initials = $derived(
		name
			.split(/\s+/)
			.slice(0, 2)
			.map((part) => part[0] ?? '')
			.join('')
			.toUpperCase()
	);
</script>

{#if src}
	<img
		{src}
		alt={name}
		loading="lazy"
		decoding="async"
		class={cn('rounded-full bg-secondary object-cover', className)}
	/>
{:else}
	<div
		class={cn(
			'flex items-center justify-center rounded-full bg-secondary text-xs font-semibold text-muted-foreground',
			className
		)}
		aria-hidden="true"
	>
		{initials}
	</div>
{/if}
