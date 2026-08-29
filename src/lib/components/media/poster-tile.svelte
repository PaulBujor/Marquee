<script lang="ts">
	import { cn } from '$lib/utils.js';
	import { Film, Tv, Heart, Star, FileQuestion } from '@lucide/svelte';
	import MediaImage from './media-image.svelte';

	interface Props {
		type?: 'movie' | 'show';
		isCustom?: boolean;
		isFavorite?: boolean;
		/** The user's own 1–5 rating; renders a small badge when set. */
		rating?: number | null;
		gradientFrom?: string;
		gradientTo?: string;
		/** Poster image URL; when set it renders behind the overlays, gradient is the fallback. */
		posterUrl?: string | null;
		/** When set (with `posterPath`), the poster renders offline-capably from the cached blob. */
		mediaId?: string;
		posterPath?: string | null;
		/** Alt text for the poster image. */
		alt?: string;
		class?: string;
		children?: import('svelte').Snippet;
	}
	let {
		type = 'movie',
		isCustom = false,
		isFavorite = false,
		rating = null,
		gradientFrom,
		gradientTo,
		posterUrl,
		mediaId,
		posterPath,
		alt = '',
		class: className,
		children,
		...restProps
	}: Props = $props();
</script>

<div
	class={cn(
		'relative flex aspect-[2/3] w-full flex-col items-end justify-end overflow-hidden rounded-md bg-secondary',
		isCustom && 'border border-dashed border-border',
		className
	)}
	style:background={!isCustom && gradientFrom
		? `linear-gradient(155deg, ${gradientFrom}, ${gradientTo ?? gradientFrom})`
		: undefined}
	{...restProps}
>
	{#if mediaId && !isCustom}
		<MediaImage
			id={mediaId}
			path={posterPath ?? null}
			kind="poster"
			{alt}
			class="absolute inset-0 h-full w-full object-cover"
		/>
	{:else if posterUrl}
		<img
			src={posterUrl}
			{alt}
			loading="lazy"
			decoding="async"
			class="absolute inset-0 h-full w-full object-cover"
		/>
	{/if}

	{#if isCustom}
		<div class="absolute inset-0 flex items-center justify-center">
			<FileQuestion class="size-[26px] text-muted-foreground" />
		</div>
	{/if}

	<div class="absolute top-2 left-2 opacity-50">
		{#if type === 'movie'}
			<Film class="size-3.5 text-white" />
		{:else}
			<Tv class="size-3.5 text-white" />
		{/if}
	</div>

	{#if isFavorite}
		<div class="absolute top-1.5 right-1.5">
			<Heart class="size-4 fill-primary text-primary" />
		</div>
	{/if}

	{#if rating != null}
		<div
			class="absolute bottom-1.5 left-1.5 flex items-center gap-0.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[11px] font-semibold text-white backdrop-blur-sm"
		>
			<Star class="size-3 fill-amber-400 text-amber-400" />
			{rating}
		</div>
	{/if}

	{@render children?.()}
</div>
