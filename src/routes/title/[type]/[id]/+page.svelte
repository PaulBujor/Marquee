<script lang="ts">
	import { afterNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import MediaBadge from '$lib/components/media/media-badge.svelte';
	import PosterTile from '$lib/components/media/poster-tile.svelte';
	import { posterUrl } from '$lib/media.js';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import PlayIcon from '@lucide/svelte/icons/play';
	import StarIcon from '@lucide/svelte/icons/star';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const detail = $derived(data.detail);
	const backdropUrl = $derived(posterUrl(detail.backdropPath, 'w780'));

	// The trailer iframe stays out of the DOM until the user clicks the thumbnail — click-to-load
	// keeps the YouTube embed (and its CSP surface) off the page for anyone who never plays it.
	let showTrailer = $state(false);
	// Reset when navigating between titles (the component instance is reused across params).
	afterNavigate(() => {
		showTrailer = false;
	});

	// Mirror the search page's back behaviour: pop history when we arrived from within the app,
	// otherwise fall back to the search page.
	let cameFromApp = $state(false);
	afterNavigate((nav) => {
		cameFromApp = nav.from != null;
	});

	function goBack() {
		if (cameFromApp) history.back();
		else goto(resolve('/search'));
	}

	/** First-letter initials for a cast avatar with no profile image. */
	function initials(name: string): string {
		return name
			.split(/\s+/)
			.slice(0, 2)
			.map((part) => part[0] ?? '')
			.join('')
			.toUpperCase();
	}
</script>

<svelte:head>
	<title>{detail.title} · Marquee</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-lg flex-col gap-6 p-6">
	<div class="flex items-center gap-3">
		<Button
			onclick={goBack}
			variant="outline"
			size="icon"
			shape="round"
			class="shrink-0 text-muted-foreground"
			aria-label="Go back"
		>
			<ChevronLeftIcon class="size-4" />
		</Button>
		<h1 class="min-w-0 truncate font-serif text-2xl font-semibold">{detail.title}</h1>
	</div>

	{#if backdropUrl}
		<img
			src={backdropUrl}
			alt={`${detail.title} backdrop`}
			loading="lazy"
			decoding="async"
			class="aspect-video w-full rounded-[14px] object-cover"
		/>
	{/if}

	<div class="flex gap-4">
		<div class="w-24 shrink-0">
			<PosterTile type={detail.type} posterUrl={posterUrl(detail.posterPath)} alt={detail.title} />
		</div>
		<div class="flex min-w-0 flex-1 flex-col gap-3">
			<div class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
				<MediaBadge>{detail.type === 'movie' ? 'Movie' : 'Show'}</MediaBadge>
				{#if detail.year}<span>{detail.year}</span>{/if}
			</div>

			<div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
				{#if detail.rating !== null}
					<span class="flex items-center gap-1.5">
						<StarIcon class="size-4 fill-primary text-primary" />
						<span class="font-semibold">{detail.rating.toFixed(1)}</span>
						<span class="text-muted-foreground">/10</span>
					</span>
				{/if}
				{#if detail.runtime !== null}
					<span class="flex items-center gap-1.5 text-muted-foreground">
						<ClockIcon class="size-4" />
						{detail.runtime} min{detail.type === 'show' ? ' / ep' : ''}
					</span>
				{/if}
			</div>

			{#if detail.genres.length > 0}
				<div class="flex flex-wrap gap-1.5">
					{#each detail.genres as genre (genre)}
						<MediaBadge variant="genre">{genre}</MediaBadge>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	{#if detail.overview}
		<p class="text-sm leading-relaxed">{detail.overview}</p>
	{/if}

	{#if detail.cast.length > 0}
		<section class="flex flex-col gap-3">
			<h2 class="text-xs font-bold tracking-widest text-muted-foreground uppercase">Cast</h2>
			<ul class="no-scrollbar flex gap-3.5 overflow-x-auto pb-1">
				{#each detail.cast as member (member.id)}
					{@const avatar = posterUrl(member.profilePath, 'w185')}
					<li class="flex w-16 shrink-0 flex-col items-center text-center">
						{#if avatar}
							<img
								src={avatar}
								alt={member.name}
								loading="lazy"
								decoding="async"
								class="size-14 rounded-full object-cover"
							/>
						{:else}
							<div
								class="flex size-14 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-muted-foreground"
								aria-hidden="true"
							>
								{initials(member.name)}
							</div>
						{/if}
						<span class="mt-1.5 text-[0.7rem] leading-tight font-medium">{member.name}</span>
						{#if member.character}
							<span class="text-[0.65rem] leading-tight text-muted-foreground"
								>{member.character}</span
							>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if detail.trailer}
		<section class="flex flex-col gap-3">
			<h2 class="text-xs font-bold tracking-widest text-muted-foreground uppercase">Trailer</h2>
			{#if showTrailer}
				<div class="aspect-video w-full overflow-hidden rounded-[14px]">
					<iframe
						src={`https://www.youtube-nocookie.com/embed/${detail.trailer.key}?autoplay=1`}
						title={detail.trailer.name}
						allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
						allowfullscreen
						class="h-full w-full border-0"
					></iframe>
				</div>
			{:else}
				<button
					type="button"
					onclick={() => (showTrailer = true)}
					class="group relative aspect-video w-full overflow-hidden rounded-[14px] bg-secondary"
					aria-label={`Play trailer: ${detail.trailer.name}`}
				>
					<img
						src={`https://img.youtube.com/vi/${detail.trailer.key}/hqdefault.jpg`}
						alt=""
						loading="lazy"
						decoding="async"
						class="absolute inset-0 h-full w-full object-cover"
					/>
					<span
						class="absolute inset-0 flex items-center justify-center bg-black/20 transition-colors group-hover:bg-black/30"
					>
						<span
							class="flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground"
						>
							<PlayIcon class="size-5 translate-x-0.5 fill-current" />
						</span>
					</span>
				</button>
			{/if}
		</section>
	{/if}
</main>
