<script lang="ts">
	import { untrack } from 'svelte';
	import { fade, slide } from 'svelte/transition';
	import { afterNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import MediaBadge from '$lib/components/media/media-badge.svelte';
	import PosterTile from '$lib/components/media/poster-tile.svelte';
	import TrackingControls from '$lib/components/media/tracking-controls.svelte';
	import NextEpisodeRow from '$lib/components/media/next-episode-row.svelte';
	import ConfirmDialog from '$lib/components/media/confirm-dialog.svelte';
	import MediaImage from '$lib/components/media/media-image.svelte';
	import HeaderScrim from '$lib/components/header-scrim.svelte';
	import OfflineState from '$lib/components/offline-state.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { posterUrl } from '$lib/media.js';
	import {
		tmdbMediaId,
		tmdbExternalId,
		type MediaRecord,
		type TrackingStatus
	} from '$lib/sync/events';
	import { isAired, todayIso } from '$lib/tracking/actions';
	import { TrackingState } from '$lib/tracking/tracking.svelte';
	import { getTracking, getEpisodes } from '$lib/client/idb';
	import { offlineSeason } from '$lib/client/media/offline-detail';
	import { sync } from '$lib/client/sync/engine.svelte.js';
	import { navigation } from '$lib/state/navigation.svelte.js';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronsLeftIcon from '@lucide/svelte/icons/chevrons-left';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import PlayIcon from '@lucide/svelte/icons/play';
	import StarIcon from '@lucide/svelte/icons/star';
	import type { MediaDetail, SeasonDetail } from '$lib/server/tmdb';

	// `detail` is always present — the cached IndexedDB copy first, upgraded in place to the full
	// network copy. `enrichState` says how to render the network-only sections (cast, trailer,
	// similar): a skeleton while the enrichment loads, the real thing once `enriched`, or an offline
	// placeholder when we're stuck on the cached copy.
	let {
		detail,
		season,
		enrichState
	}: {
		detail: MediaDetail;
		season: SeasonDetail | null;
		enrichState: 'loading' | 'enriched' | 'offline';
	} = $props();
	const offline = $derived(enrichState === 'offline');

	// The full release/first-air date to spell out in the details section (movie vs show).
	const releaseDate = $derived(detail.type === 'movie' ? detail.releaseDate : detail.firstAirDate);
	// Format a `YYYY-MM-DD` as e.g. "16 July 2010" in UTC, so a local timezone can't shift the day.
	const dateFmt = new Intl.DateTimeFormat(undefined, {
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC'
	});
	const formatDate = (iso: string) => dateFmt.format(new Date(`${iso}T00:00:00Z`));
	// Our own media id for the tracking event pipeline (provider-agnostic, MRQ-112).
	const mediaId = $derived(tmdbMediaId(detail.type, detail.tmdbId));
	// Today (YYYY-MM-DD) for the per-episode aired check — an episode is watchable once it's aired.
	const today = todayIso();

	// Media snapshot cached locally on track (renders lists offline; identity for the media
	// channel). Built from the TMDB data the page already has — scalars only; `version: 0` marks
	// it as behind so the media channel pulls the authoritative row (with full seasons/episodes).
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
		releaseDate: detail.releaseDate,
		status: detail.status,
		inProduction: detail.inProduction,
		firstAirDate: detail.firstAirDate,
		lastAirDate: detail.lastAirDate,
		version: 0,
		seasons: null,
		episodes: null
	});

	// Reactive local tracking state (IndexedDB-backed); reloaded on sync pulls. Recreated **only when
	// the media id changes** — not on the in-place base→enriched upgrade (which changes `detail`, and
	// thus `mediaRecord`). A fresh instance would reset `view`/`ready`/`watched` and re-trickle the
	// watch-status not-watched → watching → watched as it reloaded, reflowing the action row (MRQ-146).
	// `untrack` keeps the record/seasons reads from making this recompute on every enrichment.
	// Season summaries (count + air date) let a bulk "mark watched" enumerate episodes immediately,
	// before the media channel syncs per-episode air dates (MRQ-130).
	const tracking = $derived.by(() => {
		const id = mediaId;
		return untrack(() => new TrackingState(id, mediaRecord, detail.seasons));
	});
	$effect(() => {
		void sync.revision;
		tracking.load();
	});

	// Tracking status + favorite of the *similar* titles, for the badge + heart on each card — we
	// already hold this offline, keyed by our derived media id. Reloaded on sync pulls / navigation.
	const STATUS_LABEL: Record<TrackingStatus, string> = {
		want_to_watch: 'On list',
		watching: 'Watching',
		completed: 'Watched',
		did_not_finish: "Didn't finish"
	};
	let similarState = $state<Record<string, { status: TrackingStatus; favorite: boolean }>>({});
	$effect(() => {
		void sync.revision;
		void mediaId;
		loadSimilarState();
	});
	async function loadSimilarState() {
		const rows = await getTracking();
		similarState = Object.fromEntries(
			rows.map((r) => [r.mediaId, { status: r.status, favorite: r.favorite }])
		);
	}

	let detailsOpen = $state(true);
	let similarOpen = $state(true);
	let showTrailer = $state(false);

	// Seasons switch client-side (fetched from our JSON endpoint + cached); the load seeds the first.
	type SeasonData = SeasonDetail;
	let selectedSeason = $state(untrack(() => season?.seasonNumber ?? null));
	let seasonCache = $state<Record<number, SeasonData>>(
		untrack(() => (season ? { [season.seasonNumber]: season } : {}))
	);
	let seasonLoading = $state(false);
	let seasonError = $state(false);
	let preselectedFor = $state<string | null>(null);
	const currentSeason = $derived(
		selectedSeason !== null ? (seasonCache[selectedSeason] ?? null) : null
	);
	const selectedSeasonSummary = $derived(
		selectedSeason !== null
			? (detail.seasons.find((s) => s.seasonNumber === selectedSeason) ?? null)
			: null
	);
	let seasonConfirmOpen = $state(false);

	// Enrichment upgrades the page in place (no navigation): when a fresher `season` prop arrives —
	// e.g. the offline-seeded episode list replaced by the enriched network copy — fold it into the
	// cache so the open season upgrades too. afterNavigate covers the navigation case; this covers the
	// streamed in-place swap. Keyed by season number, so it never disturbs the user's own selection.
	$effect(() => {
		if (!season) return;
		const s = season;
		seasonCache[s.seasonNumber] = s;
	});

	// Episode title from the cached season data, if that season has been fetched.
	function episodeName(season: number, episode: number): string | undefined {
		return seasonCache[season]?.episodes.find((e) => e.episodeNumber === episode)?.name;
	}

	// The fixed header reveals the title once the in-content <h1> scrolls out of view.
	let titleEl = $state<HTMLElement | null>(null);
	let titleInView = $state(true);
	$effect(() => {
		const el = titleEl;
		if (!el || typeof IntersectionObserver === 'undefined') return;
		const io = new IntersectionObserver(([entry]) => (titleInView = entry.isIntersecting), {
			rootMargin: '-56px 0px 0px 0px'
		});
		io.observe(el);
		return () => io.disconnect();
	});

	// Shrink the hero title's font until the full name fits in at most two lines, so a long title
	// stays in place over the hero instead of wrapping up into the artwork. Re-runs when the title
	// changes and on viewport resize; floors at 15px (then it may wrap, but that's the rare extreme).
	const MIN_TITLE_PX = 15;
	$effect(() => {
		const el = titleEl;
		void detail.title; // re-fit on navigation to another title
		if (!el || typeof window === 'undefined') return;
		const lineCount = () =>
			Math.round(el.scrollHeight / parseFloat(getComputedStyle(el).lineHeight));
		const fit = () => {
			el.style.fontSize = ''; // back to the class base before measuring
			let px = parseFloat(getComputedStyle(el).fontSize);
			while (lineCount() > 2 && px > MIN_TITLE_PX) {
				px -= 1;
				el.style.fontSize = `${px}px`;
			}
		};
		fit();
		window.addEventListener('resize', fit);
		return () => window.removeEventListener('resize', fit);
	});

	// Pre-select the season of the next watchable episode once watch state loads (season 1 when
	// caught up). Runs after the SSR seed / nav reset; `preselectedFor` keeps it to once per title.
	$effect(() => {
		if (detail.type !== 'show' || !tracking.ready || preselectedFor === mediaId) return;
		preselectedFor = mediaId;
		const target = tracking.nextEpisode()?.season ?? 1;
		if (target !== selectedSeason && detail.seasons.some((s) => s.seasonNumber === target)) {
			void selectSeason(target);
		}
	});

	// Suggestion-chain origin + depth. Normal navigation still pushes one entry per hop (so browser
	// Back steps back one title at a time), but each "Similar" link carries the chain's origin forward
	// in `?from=` plus a `hops` counter — so a few hops deep we can also offer a jump straight back to
	// where the chain started (home, or the search that began it).
	const originParam = $derived(page.url.searchParams.get('from'));
	const hops = $derived(Math.max(0, Number(page.url.searchParams.get('hops')) || 0));
	// The origin to return to: the carried `?from` param, else where this title was entered from (home
	// or a search, tracked in the shared navigation state), else home.
	const origin = $derived(originParam ?? navigation.entryOrigin);
	// Offer the jump-to-origin control once the chain is a few hops deep.
	const showBackToOrigin = $derived(hops >= 3);

	/** A "Similar" card's href: the same route carrying the origin + an incremented hop count. */
	function similarHref(type: 'movie' | 'show', id: number): string {
		const path = resolve('/title/[type]/[id]', { type, id: String(id) });
		return `${path}?from=${encodeURIComponent(origin)}&hops=${hops + 1}`;
	}

	// Reset the per-title view state whenever the media changes — a title → title hop via a "Similar"
	// link reuses this component. The entering navigation's origin lives in the shared `navigation`
	// state (fed by the root layout), so it no longer needs to be captured here.
	afterNavigate(() => {
		showTrailer = false;
		titleInView = true;
		preselectedFor = null;
		detailsOpen = true;
		selectedSeason = season?.seasonNumber ?? null;
		seasonCache = season ? { [season.seasonNumber]: season } : {};
		seasonLoading = false;
	});

	function goToOrigin() {
		// `origin` is a runtime URL (home, or a search + query) carried in `?from=`, so it can't be a
		// branded resolve() result — same shape as the search/home query-string navigations.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		goto(origin);
	}

	function popToOrigin() {
		// Pop back through the entries the chain pushed — the initial title entry plus one per hop —
		// so the origin is reached by rewinding history, not by pushing a fresh entry on top. When the
		// back stack isn't there (e.g. a deep-linked chain URL) fall back to navigating to the origin.
		const steps = hops + 1;
		if (steps < history.length) history.go(-steps);
		else goToOrigin();
	}

	function goBack() {
		if (navigation.canGoBack) history.back();
		else goToOrigin();
	}

	async function selectSeason(seasonNumber: number) {
		if (seasonNumber === selectedSeason) return;
		selectedSeason = seasonNumber; // highlight immediately; episodes fill in when fetched
		if (seasonCache[seasonNumber]) return;
		// Offline: build the season's episode list from cached IndexedDB data instead of the network.
		if (offline) {
			const summary = detail.seasons.find((s) => s.seasonNumber === seasonNumber);
			seasonCache[seasonNumber] = offlineSeason(
				seasonNumber,
				summary?.name ?? `Season ${seasonNumber}`,
				await getEpisodes(mediaId)
			);
			return;
		}
		seasonLoading = true;
		seasonError = false;
		try {
			const res = await fetch(`/title/${detail.type}/${detail.tmdbId}/season/${seasonNumber}`);
			if (res.ok) {
				seasonCache[seasonNumber] = await res.json();
			} else {
				seasonError = true;
				console.error(
					`selectSeason: HTTP ${res.status} for ${detail.type}/${detail.tmdbId} season ${seasonNumber}`
				);
			}
		} catch (err) {
			seasonError = true;
			console.error(
				`selectSeason: failed to load ${detail.type}/${detail.tmdbId} season ${seasonNumber}`,
				err
			);
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

<!-- Fixed header over the hero: the back control is always reachable, but the blur backing + title
fade in together only once the in-content <h1> scrolls out of view — over the hero the header is
fully transparent. Blur is stronger here (over artwork) than the other headers. -->
<header class="fixed inset-x-0 top-0 z-40">
	<div
		class="absolute inset-0 transition-opacity duration-300 {titleInView
			? 'opacity-0'
			: 'opacity-100'}"
	>
		<HeaderScrim strong />
	</div>
	<div
		class="relative mx-auto flex w-full max-w-2xl items-center gap-3 px-5 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3"
	>
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
		{#if showBackToOrigin}
			<!-- A few suggestions deep: rewind straight back to where the chain started (home / search). -->
			<Button
				onclick={popToOrigin}
				variant="outline"
				size="icon"
				shape="round"
				class="shrink-0 text-muted-foreground"
				aria-label="Back to start"
				title="Back to start"
			>
				<ChevronsLeftIcon class="size-4" />
			</Button>
		{/if}
		{#if !titleInView}
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
		<!-- Poster overlaps the bottom of the backdrop; title/badges sit alongside it. -->
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
				<!-- Scaled down to fit ~two lines in place (see the fit effect), so a long title stays
				put instead of growing up into the hero artwork. -->
				<h1
					bind:this={titleEl}
					class="font-serif text-2xl leading-tight font-semibold text-balance break-words"
				>
					{detail.title}
				</h1>
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
		     when tracked; the action row adapts (movie → mark watched; show → mark series watched).
		     Held behind a fixed-height placeholder until the tracking read resolves, so the row paints
		     once in its final state instead of stepping through intermediate ones and reflowing
		     everything below it (MRQ-146). -->
		<div class="flex flex-col gap-2">
			{#if !tracking.ready}
				<div class="flex items-center gap-2" aria-hidden="true">
					<Skeleton class="h-9 w-44 rounded-full" />
					<Skeleton class="size-9 rounded-full" />
				</div>
			{:else}
				{#if detail.type === 'show' && tracking.view.tracked}
					<NextEpisodeRow {tracking} {episodeName} />
				{/if}
				<TrackingControls {tracking} type={detail.type} />
			{/if}
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

					{#if releaseDate || detail.director || detail.creators.length || detail.writers.length || detail.producers.length}
						<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
							{#if releaseDate}
								<dt class="text-muted-foreground">Released</dt>
								<dd>{formatDate(releaseDate)}</dd>
							{/if}
							{#if detail.director}
								<dt class="text-muted-foreground">Director</dt>
								<dd>{detail.director}</dd>
							{/if}
							{#if detail.creators.length > 0}
								<dt class="text-muted-foreground">
									{detail.creators.length > 1 ? 'Creators' : 'Creator'}
								</dt>
								<dd>{detail.creators.join(', ')}</dd>
							{/if}
							{#if detail.writers.length > 0}
								<dt class="text-muted-foreground">
									{detail.writers.length > 1 ? 'Writers' : 'Writer'}
								</dt>
								<dd>{detail.writers.join(', ')}</dd>
							{/if}
							{#if detail.producers.length > 0}
								<dt class="text-muted-foreground">
									{detail.producers.length > 1 ? 'Producers' : 'Producer'}
								</dt>
								<dd>{detail.producers.join(', ')}</dd>
							{/if}
						</dl>
					{/if}

					{#if enrichState === 'loading'}
						<!-- Cast + trailer skeletons while the network detail streams in over the cached copy. -->
						<div class="flex flex-col gap-4">
							<ul class="no-scrollbar flex gap-3.5 overflow-x-auto pb-1">
								{#each [0, 1, 2, 3, 4, 5] as i (i)}
									<li class="flex w-16 shrink-0 flex-col items-center gap-1.5">
										<Skeleton class="size-14 rounded-full" />
										<Skeleton class="h-3 w-12" />
									</li>
								{/each}
							</ul>
							<Skeleton class="aspect-video w-full rounded-[14px]" />
						</div>
					{:else if offline}
						<!-- Cast, trailer, and similar come from TMDB and aren't cached for offline. -->
						<OfflineState
							message="Cast, the trailer, and similar titles aren't available offline."
							class="py-6"
						/>
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

		<!-- Similar titles: TMDB recommendations + similar merged, deduped (MRQ-124). Collapsible.
		Posters use plain posterUrl (network, no offline blob); a status badge + favorite heart are
		overlaid from local tracking when we already track the title. A skeleton row shows while the
		enrichment streams in; offline (nothing cached for similar), it's simply omitted. -->
		{#if enrichState === 'loading'}
			<section class="flex flex-col gap-3">
				<div class="text-xs font-bold tracking-widest text-muted-foreground uppercase">Similar</div>
				<div class="no-scrollbar flex gap-3 overflow-x-auto pb-1">
					{#each [0, 1, 2, 3, 4] as i (i)}
						<div class="w-24 shrink-0"><Skeleton class="aspect-[2/3] w-full rounded-[14px]" /></div>
					{/each}
				</div>
			</section>
		{:else if detail.similar.length > 0}
			<section class="flex flex-col gap-3">
				<button
					type="button"
					onclick={() => (similarOpen = !similarOpen)}
					aria-expanded={similarOpen}
					class="flex items-center gap-1.5 self-start text-xs font-bold tracking-widest text-muted-foreground uppercase"
				>
					<ChevronDownIcon
						class="size-3.5 transition-transform duration-150 {similarOpen ? '' : '-rotate-90'}"
					/>
					Similar
				</button>
				{#if similarOpen}
					<ul
						class="no-scrollbar flex gap-3 overflow-x-auto pb-1"
						transition:slide={{ duration: 200 }}
					>
						{#each detail.similar as item (item.tmdbId)}
							{@const st = similarState[tmdbMediaId(item.type, item.tmdbId)]}
							<li class="w-24 shrink-0">
								<!-- Carry the chain origin + hop count forward, so a deep chain can jump back to
								where it started while normal Back still steps one title at a time. The href is
								built from resolve() + a query string, which drops resolve()'s branded type. -->
								<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
								<a href={similarHref(item.type, item.tmdbId)} class="block">
									<PosterTile
										type={item.type}
										posterUrl={posterUrl(item.posterPath)}
										isFavorite={st?.favorite ?? false}
										alt={item.title}
									/>
									<div class="mt-1.5 truncate text-xs font-medium">{item.title}</div>
									{#if st}
										<MediaBadge variant="status" class="mt-0.5"
											>{STATUS_LABEL[st.status]}</MediaBadge
										>
									{:else if item.year}
										<div class="text-[0.7rem] text-muted-foreground">{item.year}</div>
									{/if}
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}

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

				{#if tracking.view.tracked && selectedSeasonSummary && !tracking.isSeasonWatched(selectedSeasonSummary.seasonNumber)}
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
								.markSeasonWatched(selectedSeasonSummary.seasonNumber)
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
				{:else if seasonError}
					<p class="py-2 text-sm text-muted-foreground">
						Couldn't load this season. <button
							type="button"
							class="font-medium text-primary underline"
							onclick={() => {
								const s = selectedSeason;
								selectedSeason = null;
								if (s !== null) selectSeason(s);
							}}>Retry</button
						>
					</p>
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
										{#if tracking.view.tracked && currentSeason && isAired(ep, today)}
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
