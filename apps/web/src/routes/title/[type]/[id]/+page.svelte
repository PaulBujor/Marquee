<script lang="ts">
	import { untrack } from 'svelte';
	import { browser } from '$app/env';
	import { invalidate } from '$app/navigation';
	import ErrorState from '#lib/components/error-state.svelte';
	import BackButton from '#lib/components/back-button.svelte';
	import DetailSkeleton from './detail-skeleton.svelte';
	import TitleDetail from './title-detail.svelte';
	import { sync } from '#lib/client/sync/engine.svelte.js';
	import { buildOfflineDetail } from '#lib/client/media/offline-detail.js';
	import { posterUrl } from '#lib/media.js';
	import type { MediaDetail, SeasonDetail } from '#lib/server/tmdb/index.js';
	import type { PageData } from './$types';

	// Upgrades in place into one persistent TitleDetail, so the view never resets between base and enriched.
	let { data }: { data: PageData } = $props();

	let detail = $state<MediaDetail | null>(untrack(() => data.base?.detail ?? null));
	let seasonData = $state<SeasonDetail | null>(untrack(() => data.base?.season ?? null));
	let enrichState = $state<'loading' | 'enriched' | 'offline'>('loading');

	let pageState = $state<'content' | 'skeleton' | 'notfound' | 'unavailable'>(
		untrack(() => (data.base ? 'content' : 'skeleton'))
	);

	$effect(() => {
		const { base, enriched } = data;
		detail = base?.detail ?? null;
		seasonData = base?.season ?? null;
		enrichState = 'loading';
		pageState = base ? 'content' : 'skeleton';

		let cancelled = false;
		let enrichFailed = false;

		// A hard online reload has no IndexedDB, so `base` is null and a cached title would sit on the skeleton; rebuild it client-side.
		if (!base && browser && (data.type === 'movie' || data.type === 'show')) {
			buildOfflineDetail(data.type, data.id, data.season).then((built) => {
				if (cancelled || !built || pageState === 'content') return;
				detail = built.detail;
				seasonData = built.season;
				pageState = 'content';
				if (enrichFailed) enrichState = 'offline';
			});
		}

		enriched.then(async (e) => {
			if (cancelled) return;
			if (e.status === 'ok') {
				// Only wait for the hero decode while still on the skeleton; an upgraded copy is already painted.
				if (pageState === 'skeleton') await preloadHero(e.detail);
				if (cancelled) return;
				detail = e.detail;
				seasonData = e.season;
				enrichState = 'enriched';
				pageState = 'content';
			} else {
				enrichFailed = true;
				if (pageState === 'content') enrichState = 'offline';
				else if (e.status === 'notfound') pageState = 'notfound';
				else pageState = 'unavailable';
			}
		});
		return () => (cancelled = true);
	});

	let wasOnline = sync.online;
	$effect(() => {
		const online = sync.online;
		if (online && !wasOnline && untrack(() => enrichState) !== 'enriched')
			void invalidate('app:title');
		wasOnline = online;
	});

	// Decode before swapping the skeleton out, bounded by a timeout so a slow image can't strand the user.
	function preloadHero(d: MediaDetail): Promise<void> {
		if (!browser) return Promise.resolve();
		const url = d.backdropPath ? posterUrl(d.backdropPath, 'w780') : posterUrl(d.posterPath);
		if (!url) return Promise.resolve();
		const img = new Image();
		img.src = url;
		return Promise.race([
			img.decode().catch(() => {}),
			new Promise<void>((resolve) => setTimeout(resolve, 1500))
		]).then(() => {});
	}
</script>

{#snippet backHeader()}
	<header class="fixed inset-x-0 top-0 z-40">
		<div
			class="mx-auto flex w-full items-center gap-3 px-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-5"
		>
			<BackButton />
		</div>
	</header>
{/snippet}

{#if pageState === 'content' && detail}
	<TitleDetail {detail} season={seasonData} {enrichState} />
{:else if pageState === 'notfound'}
	{@render backHeader()}
	<main class="mx-auto w-full px-5 pt-[calc(5.5rem+env(safe-area-inset-top))] pb-tab-bar">
		<ErrorState message="We couldn't find this title." />
	</main>
{:else if pageState === 'unavailable'}
	{@render backHeader()}
	<main class="mx-auto w-full px-5 pt-[calc(5.5rem+env(safe-area-inset-top))] pb-tab-bar">
		<ErrorState message="This title isn't available offline yet." />
	</main>
{:else}
	{@render backHeader()}
	<DetailSkeleton />
{/if}
