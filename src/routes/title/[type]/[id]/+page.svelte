<script lang="ts">
	import { untrack } from 'svelte';
	import { slide } from 'svelte/transition';
	import { afterNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import MediaBadge from '$lib/components/media/media-badge.svelte';
	import PosterTile from '$lib/components/media/poster-tile.svelte';
	import TrackingControls from '$lib/components/media/tracking-controls.svelte';
	import NextEpisodeRow from '$lib/components/media/next-episode-row.svelte';
	import ConfirmDialog from '$lib/components/media/confirm-dialog.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { posterUrl } from '$lib/media.js';
	import { tmdbMediaId } from '$lib/sync/events';
	import { TrackingState } from '$lib/tracking/tracking.svelte';
	import { sync } from '$lib/client/sync/engine.svelte.js';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import PlayIcon from '@lucide/svelte/icons/play';
	import StarIcon from '@lucide/svelte/icons/star';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const detail = $derived(data.detail);
	const heroUrl = $derived(posterUrl(detail.backdropPath, 'w780'));
	// Our own media id for the tracking event pipeline (provider-agnostic, MRQ-112).
	const mediaId = $derived(tmdbMediaId(detail.type, detail.tmdbId));

	// Reactive local tracking state (IndexedDB-backed). Recreated + reloaded whenever the title
	// changes; SSR renders the neutral untracked state, then this hydrates on the client.
	const tracking = $derived(new TrackingState(mediaId, detail.seasons));
	$effect(() => {
		void sync.revision; // re-read local state whenever a background sync pulls new events
		tracking.load();
	});

	// Overview/cast/trailer live under a "Details" toggle (default open). When watch-tracking
	// lands it can default this collapsed for in-progress shows; read-only for now.
	let detailsOpen = $state(true);
	// The trailer iframe stays out of the DOM until the user clicks the thumbnail — click-to-load
	// keeps the YouTube embed (and its CSP surface) off the page for anyone who never plays it.
	let showTrailer = $state(false);

	// Seasons switch client-side: episodes are fetched from our own JSON endpoint and cached, so
	// picking a season never touches the URL or browser history. The server load seeds the default
	// season for first paint / SSR.
	type SeasonData = NonNullable<PageData['season']>;
	// Seed once from the SSR data (untrack marks the initial read as intentional, mirroring search).
	let selectedSeason = $state(untrack(() => data.season?.seasonNumber ?? null));
	let seasonCache = $state<Record<number, SeasonData>>(
		untrack(() => (data.season ? { [data.season.seasonNumber]: data.season } : {}))
	);
	let seasonLoading = $state(false);
	const currentSeason = $derived(
		selectedSeason !== null ? (seasonCache[selectedSeason] ?? null) : null
	);
	const selectedSeasonSummary = $derived(
		selectedSeason !== null
			? (detail.seasons.find((s) => s.seasonNumber === selectedSeason) ?? null)
			: null
	);
	// Per-season "mark watched" confirmation (bulk, hard to undo).
	let seasonConfirmOpen = $state(false);

	// Resolve an episode title from whatever season the page has cached (best-effort — the next
	// episode may live in a season not yet fetched, in which case the row shows just S/E).
	function episodeName(season: number, episode: number): string | undefined {
		return seasonCache[season]?.episodes.find((e) => e.episodeNumber === episode)?.name;
	}

	// Mirror the search page's back behaviour: pop history when we arrived from within the app,
	// otherwise fall back to the search page. Reset per-title state when navigating between titles.
	let cameFromApp = $state(false);
	afterNavigate((nav) => {
		cameFromApp = nav.from != null;
		showTrailer = false;
		selectedSeason = data.season?.seasonNumber ?? null;
		seasonCache = data.season ? { [data.season.seasonNumber]: data.season } : {};
		seasonLoading = false;
	});

	function goBack() {
		if (cameFromApp) history.back();
		else goto(resolve('/search'));
	}

	async function selectSeason(seasonNumber: number) {
		if (seasonNumber === selectedSeason) return;
		selectedSeason = seasonNumber; // highlight immediately; episodes fill in when fetched
		if (seasonCache[seasonNumber]) return;
		seasonLoading = true;
		try {
			const res = await fetch(`/title/${detail.type}/${detail.tmdbId}/season/${seasonNumber}`);
			if (res.ok) seasonCache[seasonNumber] = await res.json();
		} finally {
			seasonLoading = false;
		}
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

{#snippet backButton(extraClass: string)}
	<Button
		onclick={goBack}
		variant="outline"
		size="icon"
		shape="round"
		class="text-muted-foreground {extraClass}"
		aria-label="Go back"
	>
		<ChevronLeftIcon class="size-4" />
	</Button>
{/snippet}

<main class="mx-auto w-full max-w-lg">
	{#if heroUrl}
		<div class="relative">
			<img
				src={heroUrl}
				alt={`${detail.title} backdrop`}
				decoding="async"
				class="aspect-video w-full object-cover"
			/>
			<div
				class="absolute inset-0 bg-gradient-to-t from-background via-background/30 to-transparent"
			></div>
			{@render backButton('absolute top-4 left-5 z-10 bg-background dark:bg-background')}
		</div>
	{/if}

	<div class="flex flex-col gap-4 px-5 pb-10 {heroUrl ? '-mt-14' : 'pt-4'}">
		{#if !heroUrl}
			{@render backButton('self-start')}
		{/if}

		<!-- Poster overlaps the bottom of the backdrop; title/badges sit below the hero -->
		<div class="flex items-end gap-4">
			<div class="w-24 shrink-0">
				<PosterTile
					type={detail.type}
					posterUrl={posterUrl(detail.posterPath)}
					alt={detail.title}
					class="shadow-xl ring-4 ring-background"
				/>
			</div>
			<div class="flex min-w-0 flex-1 flex-col gap-2 pb-1">
				<h1 class="font-serif text-2xl font-semibold">{detail.title}</h1>
				<div class="flex flex-wrap items-center gap-2">
					<MediaBadge>
						{detail.type === 'movie' ? 'Movie' : 'Show'}{detail.year ? ` · ${detail.year}` : ''}
					</MediaBadge>
				</div>
			</div>
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
			{#each detail.genres as genre (genre)}
				<MediaBadge variant="genre">{genre}</MediaBadge>
			{/each}
		</div>

		<!-- Watch-tracking controls, above the description. Shows get an extra "next episode" row
		     when tracked; the action row adapts (movie → mark watched; show → mark series watched). -->
		<div class="flex flex-col gap-2">
			{#if detail.type === 'show' && tracking.view.tracked}
				<NextEpisodeRow {tracking} {episodeName} />
			{/if}
			<TrackingControls {tracking} type={detail.type} />
		</div>

		<!-- Collapsible details: overview, cast, trailer -->
		<div class="flex flex-col gap-4">
			<button
				type="button"
				onclick={() => (detailsOpen = !detailsOpen)}
				aria-expanded={detailsOpen}
				class="flex items-center gap-1.5 self-start text-xs font-bold tracking-widest text-muted-foreground uppercase"
			>
				<ChevronDownIcon
					class="size-3.5 transition-transform duration-150 {detailsOpen ? '' : '-rotate-90'}"
				/>
				Details
			</button>

			{#if detailsOpen}
				<div class="flex flex-col gap-4" transition:slide={{ duration: 200 }}>
					{#if detail.overview}
						<p class="text-sm leading-relaxed">{detail.overview}</p>
					{/if}

					{#if detail.cast.length > 0}
						<section class="flex flex-col gap-3">
							<h2 class="text-xs font-bold tracking-widest text-muted-foreground uppercase">
								Cast
							</h2>
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
										<span class="mt-1.5 text-[0.7rem] leading-tight font-medium">{member.name}</span
										>
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
							<h2 class="text-xs font-bold tracking-widest text-muted-foreground uppercase">
								Trailer
							</h2>
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
				</div>
			{/if}
		</div>

		<!-- Seasons + episodes (shows only) -->
		{#if detail.type === 'show' && detail.seasons.length > 0}
			<section class="flex flex-col gap-3">
				<h2 class="text-xs font-bold tracking-widest text-muted-foreground uppercase">Seasons</h2>
				<div class="no-scrollbar flex gap-2 overflow-x-auto pb-1">
					{#each detail.seasons as s (s.seasonNumber)}
						{@const active = s.seasonNumber === selectedSeason}
						<button
							type="button"
							onclick={() => selectSeason(s.seasonNumber)}
							aria-current={active ? 'true' : undefined}
							class="shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors {active
								? 'border-primary bg-primary text-primary-foreground'
								: 'border-border text-muted-foreground hover:text-foreground'}"
						>
							{s.name}
						</button>
					{/each}
				</div>

				{#if tracking.view.tracked && selectedSeasonSummary && !tracking.isSeasonWatched(selectedSeasonSummary)}
					<Button
						variant="outline"
						size="sm"
						class="self-start"
						onclick={() => (seasonConfirmOpen = true)}
						disabled={tracking.busy}
					>
						Mark {selectedSeasonSummary.name} watched
					</Button>
					<ConfirmDialog
						bind:open={seasonConfirmOpen}
						title="Mark this season as watched?"
						description={`This marks every episode of ${selectedSeasonSummary.name} watched.`}
						confirmLabel="Mark season watched"
						busy={tracking.busy}
						onconfirm={() =>
							selectedSeasonSummary &&
							tracking
								.markSeasonWatched({
									seasonNumber: selectedSeasonSummary.seasonNumber,
									episodeCount: selectedSeasonSummary.episodeCount
								})
								.then(() => (seasonConfirmOpen = false))}
					/>
				{/if}

				{#if seasonLoading}
					<ul class="flex flex-col">
						{#each Array.from({ length: 10 }, (_, i) => i) as i (i)}
							<li class="flex flex-col gap-2 border-b border-border py-3 last:border-b-0">
								<div class="flex items-center gap-3">
									<Skeleton class="h-4 w-6 shrink-0" />
									<Skeleton class="h-4 w-2/5" />
								</div>
								<div class="flex flex-col gap-1 pl-9">
									<Skeleton class="h-3 w-16" />
									<Skeleton class="h-3 w-full" />
									<Skeleton class="h-3 w-3/4" />
								</div>
							</li>
						{/each}
					</ul>
				{:else if currentSeason}
					{#if currentSeason.episodes.length > 0}
						<ul class="flex flex-col">
							{#each currentSeason.episodes as ep (ep.episodeNumber)}
								<li class="flex flex-col gap-1 border-b border-border py-3 last:border-b-0">
									<div class="flex items-center gap-3">
										<span class="w-6 shrink-0 text-sm font-semibold text-muted-foreground"
											>{ep.episodeNumber}</span
										>
										<span class="min-w-0 flex-1 truncate text-sm font-medium">{ep.name}</span>
										{#if ep.runtime}
											<span
												class="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[0.65rem] font-medium text-muted-foreground"
												>{ep.runtime} min</span
											>
										{/if}
										{#if tracking.view.tracked && currentSeason}
											{@const watched = tracking.isWatched(
												currentSeason.seasonNumber,
												ep.episodeNumber
											)}
											<Button
												variant="ghost"
												size="icon"
												onclick={() =>
													tracking.setEpisodeWatched(
														currentSeason.seasonNumber,
														ep.episodeNumber,
														!watched
													)}
												disabled={tracking.busy}
												aria-pressed={watched}
												aria-label={`${watched ? 'Unmark' : 'Mark'} S${currentSeason.seasonNumber}E${ep.episodeNumber} watched`}
												class="size-6 shrink-0 rounded-full border {watched
													? 'border-primary bg-primary text-primary-foreground'
													: 'border-border text-transparent hover:border-primary'}"
											>
												<CheckIcon class="size-3.5" />
											</Button>
										{/if}
									</div>
									{#if ep.airDate || ep.overview}
										<div class="flex flex-col gap-0.5 pl-9">
											{#if ep.airDate}
												<span class="text-xs text-muted-foreground">{ep.airDate}</span>
											{/if}
											{#if ep.overview}
												<p class="line-clamp-3 text-xs leading-relaxed text-muted-foreground">
													{ep.overview}
												</p>
											{/if}
										</div>
									{/if}
								</li>
							{/each}
						</ul>
					{:else}
						<p class="py-2 text-sm text-muted-foreground">No episodes listed for this season.</p>
					{/if}
				{/if}
			</section>
		{/if}
	</div>
</main>
