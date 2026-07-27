<script lang="ts">
	import { untrack } from 'svelte';
	import { browser } from '$app/environment';
	import { invalidate } from '$app/navigation';
	import ErrorState from '$lib/components/error-state.svelte';
	import BackButton from '$lib/components/back-button.svelte';
	import DetailSkeleton from './detail-skeleton.svelte';
	import TitleDetail from './title-detail.svelte';
	import { sync } from '$lib/client/sync/engine.svelte';
	import { posterUrl } from '$lib/media';
	import type { MediaDetail, SeasonDetail } from '$lib/server/tmdb';
	import type { PageData } from './$types';

	// Offline-first orchestrator: render the cached copy immediately, then upgrade to the streamed
	// network detail when it lands (in place — one persistent TitleDetail, so the view doesn't reset).
	// The rich page lives in TitleDetail; here we just pick base vs. enriched and the surrounding state.
	let { data }: { data: PageData } = $props();

	// Seed from the initial `data` (untracked — the effect below re-syncs on every later navigation).
	let detail = $state<MediaDetail | null>(untrack(() => data.base?.detail ?? null));
	let seasonData = $state<SeasonDetail | null>(untrack(() => data.base?.season ?? null));
	// How the network-only sections (cast, trailer, similar) should render.
	let enrichState = $state<'loading' | 'enriched' | 'offline'>('loading');
	let pageState = $state<'content' | 'skeleton' | 'notfound' | 'unavailable'>(
		untrack(() => (data.base ? 'content' : 'skeleton'))
	);

	// Resolve the streamed enrichment for the current navigation; reset to the cached base first.
	$effect(() => {
		const { base, enriched } = data;
		detail = base?.detail ?? null;
		seasonData = base?.season ?? null;
		enrichState = 'loading';
		pageState = base ? 'content' : 'skeleton';

		let cancelled = false;
		enriched.then(async (e) => {
			if (cancelled) return;
			if (e.status === 'ok') {
				// First visit (no cached copy → still on the skeleton): wait for the hero image to
				// decode before revealing the content, so it doesn't paint into a blank hero for a
				// frame (MRQ-145). Cached titles are already showing content — upgrade in place.
				if (!base) await preloadHero(e.detail);
				if (cancelled) return;
				detail = e.detail;
				seasonData = e.season;
				enrichState = 'enriched';
				pageState = 'content';
			} else if (e.status === 'notfound') {
				// A real miss with no cached copy is a 404; if we have a cached copy, keep showing it.
				if (base) enrichState = 'offline';
				else pageState = 'notfound';
			} else {
				// Offline / upstream error — keep the cached copy with offline placeholders, or, with
				// nothing cached, say so.
				if (base) enrichState = 'offline';
				else pageState = 'unavailable';
			}
		});
		return () => (cancelled = true);
	});

	// Auto-refresh: when connectivity returns while we're still on the cached copy, re-enrich in place.
	let wasOnline = sync.online;
	$effect(() => {
		const online = sync.online;
		if (online && !wasOnline && untrack(() => enrichState) !== 'enriched')
			void invalidate('app:title');
		wasOnline = online;
	});

	// Decode the hero image (backdrop, else poster) before we swap the skeleton for the content, so
	// the first painted frame already has artwork instead of a blank hero (MRQ-145). Bounded by a
	// short timeout so a slow or broken image can never strand the user on the skeleton.
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
			class="mx-auto flex w-full max-w-2xl items-center gap-3 px-5 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3"
		>
			<BackButton />
		</div>
	</header>
{/snippet}

{#if pageState === 'content' && detail}
	<TitleDetail {detail} season={seasonData} {enrichState} />
{:else if pageState === 'notfound'}
	{@render backHeader()}
	<main class="mx-auto w-full max-w-2xl px-5 pt-[calc(4.5rem+env(safe-area-inset-top))]">
		<ErrorState message="We couldn't find this title." />
	</main>
{:else if pageState === 'unavailable'}
	{@render backHeader()}
	<main class="mx-auto w-full max-w-2xl px-5 pt-[calc(4.5rem+env(safe-area-inset-top))]">
		<ErrorState message="This title isn't available offline yet." />
	</main>
{:else}
	{@render backHeader()}
	<DetailSkeleton />
{/if}
