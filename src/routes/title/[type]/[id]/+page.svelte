<script lang="ts">
	import { untrack } from 'svelte';
	import { fade, slide } from 'svelte/transition';
	import { afterNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import MediaBadge from '$lib/components/media/media-badge.svelte';
	import PosterTile from '$lib/components/media/poster-tile.svelte';
	import TrackingControls from '$lib/components/media/tracking-controls.svelte';
	import NextEpisodeRow from '$lib/components/media/next-episode-row.svelte';
	import ConfirmDialog from '$lib/components/media/confirm-dialog.svelte';
	import MediaImage from '$lib/components/media/media-image.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { posterUrl } from '$lib/media.js';
	import { tmdbMediaId, tmdbExternalId, type MediaRecord } from '$lib/sync/events';
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
	// Our own media id for the tracking event pipeline (provider-agnostic, MRQ-112).
	const mediaId = $derived(tmdbMediaId(detail.type, detail.tmdbId));

	// Media snapshot cached locally on track (renders lists offline; identity for the media
	// channel). Built from the TMDB data the page already has.
	const mediaRecord = $derived<MediaRecord>({
		id: mediaId,
		provider: 'tmdb',
		externalId: tmdbExternalId(detail.type, detail.tmdbId),
		source: 'linked',
		type: detail.type,
		title: detail.title,
		year: detail.year,
		posterPath: detail.posterPath,
		backdropPath: detail.backdropPath,
		overview: detail.overview,
		genres: detail.genres,
		seasons:
			detail.type === 'show'
				? detail.seasons.map((s) => ({
						seasonNumber: s.seasonNumber,
						episodeCount: s.episodeCount
					}))
				: null,
		lastAired: detail.lastAired
	});

	// Reactive local tracking state (IndexedDB-backed). Recreated + reloaded whenever the title
	// changes; SSR renders the neutral untracked state, then this hydrates on the client.
	const tracking = $derived(new TrackingState(mediaId, mediaRecord));
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
	// Guards the one-shot season pre-selection so it runs once per title and never overrides a
	// manual pick (reset on navigation).
	let preselectedFor = $state<string | null>(null);
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

	// Fixed header state: once the in-content title scrolls out of view, the header shows its
	// blur+gradient backing and echoes the title; while it's still visible the header floats
	// transparently over the hero and its controls read against the artwork behind them.
	let titleEl = $state<HTMLElement | null>(null);
	let titleInView = $state(true);
	const showTitle = $derived(!titleInView);
	// Over the hero (a backdrop exists and its title hasn't scrolled away) the back button floats
	// on artwork, so it wears a dark frosted-glass chip that stays legible on any backdrop.
	const overHero = $derived(!!detail.backdropPath && titleInView);

	// Observe the in-content <h1> so the header knows when to reveal the title.
	$effect(() => {
		const el = titleEl;
		if (!el || typeof IntersectionObserver === 'undefined') return;
		const io = new IntersectionObserver(([entry]) => (titleInView = entry.isIntersecting), {
			// Trip just before the title slides fully under the fixed header.
			rootMargin: '-56px 0px 0px 0px'
		});
		io.observe(el);
		return () => io.disconnect();
	});

	// Pre-select the season holding the next watchable episode once local watch state has loaded
	// (a show's next aired-unwatched episode; season 1 when caught up / fully watched). Runs after
	// the SSR seed and the navigation reset; the `preselectedFor` guard keeps it to once per title
	// and out of the way of manual season picks.
	$effect(() => {
		if (detail.type !== 'show' || !tracking.ready || preselectedFor === mediaId) return;
		preselectedFor = mediaId;
		const target = tracking.nextEpisode()?.season ?? 1;
		if (target !== selectedSeason && detail.seasons.some((s) => s.seasonNumber === target)) {
			void selectSeason(target);
		}
	});

	// Mirror the search page's back behaviour: pop history when we arrived from within the app,
	// otherwise fall back to the search page. Reset per-title state when navigating between titles.
	let cameFromApp = $state(false);
	afterNavigate((nav) => {
		cameFromApp = nav.from != null;
		showTrailer = false;
		titleInView = true;
		preselectedFor = null;
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

<!-- Fixed header over the hero: an always-reachable back control that, once the in-content title
scrolls out of view, gains a blur+gradient backing and echoes the title. Over the hero the back
button wears a dark frosted-glass chip so it stays legible on any backdrop. -->
<header class="fixed inset-x-0 top-0 z-40">
	<div
		class="pointer-events-none absolute inset-0 backdrop-blur-md transition-opacity duration-200 {showTitle
			? 'opacity-100'
			: 'opacity-0'}"
		style="background:linear-gradient(to bottom, var(--color-background), color-mix(in oklab, var(--color-background) 70%, transparent) 65%, transparent);"
	></div>
	<div
		class="relative mx-auto flex w-full max-w-2xl items-center gap-3 px-5 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3"
	>
		<Button
			onclick={goBack}
			variant={overHero ? 'ghost' : 'outline'}
			size="icon"
			shape="round"
			class="shrink-0 transition-colors {overHero
				? 'border-white/20 bg-black/40 text-white backdrop-blur-md hover:bg-black/55 hover:text-white active:bg-black/60 dark:hover:bg-black/55'
				: 'text-muted-foreground'}"
			aria-label="Go back"
		>
			<ChevronLeftIcon class="size-4" />
		</Button>
		{#if showTitle}
			<h2
				class="min-w-0 flex-1 truncate font-serif text-lg font-semibold"
				transition:fade={{ duration: 150 }}
			>
				{detail.title}
			</h2>
		{/if}
	</div>
</header>

<main class="mx-auto w-full max-w-2xl">
	{#if detail.backdropPath}
		<div class="relative">
			<MediaImage
				id={mediaId}
				path={detail.backdropPath}
				kind="backdrop"
				size="w780"
				alt={`${detail.title} backdrop`}
				class="aspect-video w-full object-cover"
			/>
			<div
				class="absolute inset-0 bg-gradient-to-t from-background via-background/30 to-transparent"
			></div>
		</div>
	{/if}

	<div
		class="flex flex-col gap-4 px-5 pb-10 {detail.backdropPath
			? '-mt-14'
			: 'pt-[calc(3.5rem+env(safe-area-inset-top))]'}"
	>
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
				<h1 bind:this={titleEl} class="font-serif text-2xl font-semibold">{detail.title}</h1>
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
										{#if tracking.view.tracked && currentSeason && tracking.hasAired(currentSeason.seasonNumber, ep.episodeNumber)}
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
