<script lang="ts">
	import { untrack } from 'svelte';
	import { fade, slide } from 'svelte/transition';
	import { afterNavigate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Button } from '#lib/components/ui/button/index.js';
	import ExpandableText from '#lib/components/expandable-text.svelte';
	import MediaBadge from '#lib/components/media/media-badge.svelte';
	import MediaTypeLabel from '#lib/components/media/media-type-label.svelte';
	import PosterTile from '#lib/components/media/poster-tile.svelte';
	import TitleMetaRow from '#lib/components/media/title-meta-row.svelte';
	import TrailerPlayer from '#lib/components/media/trailer-player.svelte';
	import TrackingControls from '#lib/components/media/tracking-controls.svelte';
	import NextEpisodeRow from '#lib/components/media/next-episode-row.svelte';
	import ConfirmDialog from '#lib/components/media/confirm-dialog.svelte';
	import MediaImage from '#lib/components/media/media-image.svelte';
	import PersonAvatar from '#lib/components/media/person-avatar.svelte';
	import LinkedEntryNotice from '#lib/components/media/linked-entry-notice.svelte';
	import ShareButton from '#lib/components/share-button.svelte';
	import HeaderScrim from '#lib/components/header-scrim.svelte';
	import OfflineState from '#lib/components/offline-state.svelte';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { hasDescription, posterUrl } from '#lib/media.js';
	import { formatExactDateTime, formatRelativeDay } from '#lib/date.js';
	import {
		tmdbMediaId,
		tmdbExternalId,
		type MediaRecord,
		type TrackingStatus
	} from '#lib/sync/events.js';
	import {
		productionState,
		isAired,
		seasonCount,
		todayIso,
		watchedKey,
		type DatedEpisode
	} from '#lib/tracking/actions.js';
	import { deriveStatus } from '#lib/tracking/derive-status.js';
	import { TrackingState } from '#lib/tracking/tracking.svelte.js';
	import {
		getTracking,
		getEpisodes,
		getAllMedia,
		getEpisodeWatches
	} from '#lib/client/idb/index.js';
	import { offlineSeason } from '#lib/client/media/offline-detail.js';
	import { sync } from '#lib/client/sync/engine.svelte.js';
	import { navigation } from '#lib/state/navigation.svelte.js';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import type { CrewMember, MediaDetail, SeasonDetail } from '#lib/server/tmdb/index.js';
	import { navigate } from '#lib/client/navigate.js';

	// `detail` is always present (cached copy first), so network-only sections key off `enrichState` alone.
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

	const releaseDate = $derived(detail.type === 'movie' ? detail.releaseDate : detail.firstAirDate);
	// Format a `YYYY-MM-DD` as e.g. "16 July 2010" in UTC, so a local timezone can't shift the day.
	const dateFmt = new Intl.DateTimeFormat(undefined, {
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC'
	});
	const formatDate = (iso: string) => dateFmt.format(new Date(`${iso}T00:00:00Z`));
	const mediaId = $derived(tmdbMediaId(detail.type, detail.tmdbId));
	const seasons = $derived(detail.type === 'show' ? seasonCount(detail.seasons) : 0);
	const production = $derived(
		detail.type === 'show' ? productionState(detail.inProduction) : 'unknown'
	);
	const today = todayIso();

	// `version: 0` marks this snapshot as behind, so the media channel pulls the authoritative row with full seasons/episodes.
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
		episodes: null,
		credits: null
	});

	// Recreated only when the media id changes: on the base→enriched upgrade a fresh instance would re-trickle the watch status and reflow the action row.
	const tracking = $derived.by(() => {
		const id = mediaId;
		return untrack(() => new TrackingState(id, mediaRecord, detail.seasons));
	});
	$effect(() => {
		void sync.revision;
		tracking.load();
	});
	// Seasons + production stay live despite `tracking`'s frozen identity, or a stale cached title never picks up synced data.
	$effect(() => {
		tracking.updateSeasons(detail.seasons);
		tracking.updateInProduction(detail.inProduction);
	});

	// Derived like the dashboard (`deriveStatus`), so a fully-caught-up show shows correctly here too.
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
		const [rows, media] = await Promise.all([getTracking(), getAllMedia()]);
		const mediaById = new Map(media.map((m) => [m.id, m]));
		const entries = await Promise.all(
			rows.map(async (r) => {
				const m = mediaById.get(r.mediaId);
				let episodes: DatedEpisode[] = [];
				let watched = new Set<string>();
				if (m?.type === 'show') {
					const [watches, eps] = await Promise.all([
						getEpisodeWatches(r.mediaId),
						getEpisodes(r.mediaId)
					]);
					watched = new Set(
						watches.filter((w) => w.watched).map((w) => watchedKey(w.season, w.episode))
					);
					episodes = eps.map((e) => ({ season: e.season, episode: e.episode, airDate: e.airDate }));
				}
				return [
					r.mediaId,
					{
						status: deriveStatus({
							type: m?.type ?? 'movie',
							projectedStatus: r.status,
							episodes,
							watched,
							inProduction: m?.inProduction ?? null
						}),
						favorite: r.favorite
					}
				] as const;
			})
		);
		similarState = Object.fromEntries(entries);
	}

	let detailsOpen = $state(true);
	const shareTitle = $derived(detail.year ? `${detail.title} (${detail.year})` : detail.title);
	let similarOpen = $state(true);
	let showTrailer = $state(false);

	// Seasons switch client-side from the JSON endpoint; the load seeds the first.
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

	const selectedSeasonOverview = $derived(
		[currentSeason?.overview, selectedSeasonSummary?.overview].find(hasDescription) ?? null
	);
	const seasonNotReady = $derived(
		selectedSeasonSummary !== null &&
			!tracking.readyToMarkSeason(selectedSeasonSummary.seasonNumber)
	);
	let seasonConfirmOpen = $state(false);

	// The streamed in-place swap replaces the `season` prop; fold it into the cache so the open season upgrades too.
	$effect(() => {
		if (!season) return;
		const s = season;
		seasonCache[s.seasonNumber] = s;
	});

	function episodeName(season: number, episode: number): string | undefined {
		return seasonCache[season]?.episodes.find((e) => e.episodeNumber === episode)?.name;
	}

	// Header reveals the title once the <h1> scrolls past it (-56px is the header height).
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

	// Shrink until the name fits two lines so a long title stays over the hero; floors at 15px.
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

	// `preselectedFor` keeps this to once per title, after the SSR seed / nav reset.
	$effect(() => {
		if (detail.type !== 'show' || !tracking.ready || preselectedFor === mediaId) return;
		preselectedFor = mediaId;
		const target = tracking.nextEpisode()?.season ?? 1;
		if (target !== selectedSeason && detail.seasons.some((s) => s.seasonNumber === target)) {
			void selectSeason(target);
		}
	});

	// Each "Similar" link carries the chain's origin in `?from=`, so a cold-opened title still knows where the chain began.
	const originParam = $derived(page.url.searchParams.get('from'));
	const origin = $derived(originParam ?? navigation.entryOrigin);

	function similarHref(type: 'movie' | 'show', id: number): string {
		const path = resolve('/title/[type]/[id]', { type, id: String(id) });
		return `${path}?from=${encodeURIComponent(origin)}`;
	}

	// A "Similar" hop reuses this component, so the per-title view state must reset on the media change.
	afterNavigate(({ shallow, type }) => {
		if (shallow && type === 'goto') return;

		showTrailer = false;
		titleInView = true;
		preselectedFor = null;
		detailsOpen = true;
		selectedSeason = season?.seasonNumber ?? null;
		seasonCache = season ? { [season.seasonNumber]: season } : {};
		seasonLoading = false;
	});

	function goToOrigin() {
		navigate(origin);
	}

	function goBack() {
		if (navigation.canGoBack) history.back();
		else goToOrigin();
	}

	async function selectSeason(seasonNumber: number) {
		if (seasonNumber === selectedSeason) return;
		selectedSeason = seasonNumber; // highlight immediately; episodes fill in when fetched
		if (seasonCache[seasonNumber]) return;
		if (offline) {
			const summary = detail.seasons.find((s) => s.seasonNumber === seasonNumber);
			seasonCache[seasonNumber] = offlineSeason(
				seasonNumber,
				summary?.name ?? `Season ${seasonNumber}`,
				summary?.overview ?? '',
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

	/** Un-annotated so `resolve()`'s branded type survives; the resolved-href lint rule keys on it. */
	function personHref(id: number) {
		return resolve('/person/[id]', { id: String(id) });
	}
</script>

<svelte:head>
	<title>{detail.title} · Marquee</title>
</svelte:head>

<!-- The separator's space is an entity: Svelte trims a literal trailing space at the end of an element. -->
{#snippet crewNames(members: CrewMember[])}
	{#each members as member, i (member.id)}
		{#if i > 0}
			<span>,</span>
		{/if}

		<a
			href={personHref(member.id)}
			class="underline decoration-dotted underline-offset-4 hover:decoration-solid">{member.name}</a
		>
	{/each}
{/snippet}

<!-- Transparent over the hero; the blur backing and title only appear once the <h1> scrolls out of view. -->
<header class="fixed inset-x-0 top-0 z-40">
	<HeaderScrim strong show={!titleInView} />
	<div
		class="relative mx-auto flex w-full items-center gap-3 px-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-5"
	>
		<!-- Ghost, no plate, over artwork; `icon-lg` is 44px so the target is full-size even with nothing drawn. -->
		<Button
			onclick={goBack}
			variant="ghost"
			size="icon-lg"
			shape="round"
			class="shrink-0"
			aria-label="Go back"
		>
			<ChevronLeftIcon class="size-5" />
		</Button>
		{#if !titleInView}
			<h2
				class="min-w-0 flex-1 truncate font-serif text-lg font-semibold"
				transition:fade={{ duration: 150 }}
			>
				{detail.title}
			</h2>
		{/if}
		<!-- Trailing action, so it holds the right edge whether or not the title is showing. -->
		<ShareButton
			class="ml-auto shrink-0"
			path={resolve('/s/[type]/[id]', { type: detail.type, id: String(detail.tmdbId) })}
			title={shareTitle}
			warm={{ type: detail.type, id: detail.tmdbId }}
			label="Share this title"
		/>
	</div>
</header>

<main class="mx-auto w-full">
	{#if detail.backdropPath}
		<div class="relative">
			<MediaImage
				id={mediaId}
				path={detail.backdropPath}
				kind="backdrop"
				size="w780"
				alt={`${detail.title} backdrop`}
				class="aspect-video max-h-[300px] w-full object-cover"
			/>
			<div
				class="absolute inset-0 bg-gradient-to-t from-background via-background/30 to-transparent"
			></div>
		</div>
	{/if}

	<div
		class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 pb-tab-bar {detail.backdropPath
			? '-mt-14'
			: 'pt-[calc(4.75rem+env(safe-area-inset-top))]'}"
	>
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
				<h1
					bind:this={titleEl}
					class="font-serif text-2xl leading-tight font-semibold text-balance break-words"
				>
					{detail.title}
				</h1>
				<div class="flex flex-wrap items-center gap-2">
					<MediaTypeLabel type={detail.type} year={detail.year} {seasons} />

					{#if production === 'in_production'}
						<MediaBadge variant="production">
							<span class="size-1.5 rounded-full bg-primary"></span>In production
						</MediaBadge>
					{:else if production === 'ended'}
						<MediaBadge variant="status">Ended</MediaBadge>
					{/if}
				</div>
			</div>
		</div>

		<TitleMetaRow
			type={detail.type}
			rating={detail.rating}
			runtime={detail.runtime}
			genres={detail.genres}
		/>

		<!-- Placeholder until the tracking read resolves, so the row paints once in its final height instead of reflowing. -->
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
			<!-- Only when a custom entry was matched here: once linked it is off every list, so this is the only place the link stays reversible. -->
			<LinkedEntryNotice {mediaId} />
		</div>

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
								<dd>{@render crewNames([detail.director])}</dd>
							{/if}
							{#if detail.creators.length > 0}
								<dt class="text-muted-foreground">
									{detail.creators.length > 1 ? 'Creators' : 'Creator'}
								</dt>
								<dd>{@render crewNames(detail.creators)}</dd>
							{/if}
							{#if detail.writers.length > 0}
								<dt class="text-muted-foreground">
									{detail.writers.length > 1 ? 'Writers' : 'Writer'}
								</dt>
								<dd>{@render crewNames(detail.writers)}</dd>
							{/if}
							{#if detail.producers.length > 0}
								<dt class="text-muted-foreground">
									{detail.producers.length > 1 ? 'Producers' : 'Producer'}
								</dt>
								<dd>{@render crewNames(detail.producers)}</dd>
							{/if}
						</dl>
					{/if}

					{#if enrichState === 'loading'}
						<div class="flex flex-col gap-4">
							<ul class="no-scrollbar flex gap-3.5 overflow-x-auto pb-1">
								{#each [0, 1, 2, 3, 4, 5] as i (i)}
									<li class="flex w-16 shrink-0 flex-col items-center gap-1.5">
										<Skeleton class="size-14 rounded-full" />
										<Skeleton class="h-3 w-12" />
									</li>
								{/each}
							</ul>
							<Skeleton class="aspect-video w-full rounded-md" />
						</div>
					{:else if offline}
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
									<li class="w-16 shrink-0">
										<a
											href={personHref(member.id)}
											class="flex w-full flex-col items-center rounded-lg text-center focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
										>
											<PersonAvatar
												name={member.name}
												profilePath={member.profilePath}
												class="size-14"
											/>
											<span class="mt-1.5 text-[0.7rem] leading-tight font-medium"
												>{member.name}</span
											>
											{#if member.character}
												<span class="text-[0.65rem] leading-tight text-muted-foreground"
													>{member.character}</span
												>
											{/if}
										</a>
									</li>
								{/each}
							</ul>
						</section>
					{/if}

					<TrailerPlayer trailer={detail.trailer} bind:playing={showTrailer} />
				</div>
			{/if}
		</div>

		{#if enrichState === 'loading'}
			<section class="flex flex-col gap-3">
				<div class="text-xs font-bold tracking-widest text-muted-foreground uppercase">Similar</div>
				<div class="no-scrollbar flex gap-3 overflow-x-auto pb-1">
					{#each [0, 1, 2, 3, 4] as i (i)}
						<div class="w-24 shrink-0"><Skeleton class="aspect-[2/3] w-full rounded-md" /></div>
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
								<!-- Chain origin carried forward in `?from=`; the href is resolve() + a query string, which drops the branded type. -->
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

				{#if selectedSeasonOverview}
					{#key selectedSeason}
						<ExpandableText
							text={selectedSeasonOverview}
							lines={4}
							class="text-sm leading-relaxed text-muted-foreground"
						/>
					{/key}
				{/if}

				{#if tracking.view.tracked && selectedSeasonSummary && !tracking.isSeasonWatched(selectedSeasonSummary.seasonNumber)}
					<Button
						variant="outline"
						size="sm"
						class="self-start"
						onclick={() => (seasonConfirmOpen = true)}
						disabled={tracking.busy || seasonNotReady}
						aria-busy={seasonNotReady}
					>
						{#if seasonNotReady}
							<RefreshCwIcon class="size-4 animate-spin" />
							Loading episodes…
						{:else}
							Mark {selectedSeasonSummary.name} watched
						{/if}
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
								{@const epWatchedAt = currentSeason
									? tracking.watchedAtFor(currentSeason.seasonNumber, ep.episodeNumber)
									: null}
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
									{#if ep.airDate || ep.overview || epWatchedAt !== null}
										<div class="flex flex-col gap-0.5 pl-9">
											{#if ep.airDate}
												<span class="text-xs text-muted-foreground">{ep.airDate}</span>
											{/if}
											{#if epWatchedAt !== null}
												<span
													class="text-xs font-medium text-primary"
													title={formatExactDateTime(epWatchedAt)}
												>
													Watched {formatRelativeDay(epWatchedAt)}
												</span>
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
