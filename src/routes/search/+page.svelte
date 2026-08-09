<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { afterNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import PageHeader from '$lib/components/page-header.svelte';
	import MediaTypeLabel from '$lib/components/media/media-type-label.svelte';
	import PosterTile from '$lib/components/media/poster-tile.svelte';
	import SearchQuickAdd from '$lib/components/media/search-quick-add.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { posterUrl } from '$lib/media.js';
	import {
		addRecentSearch,
		clearRecentSearches,
		getRecentSearches,
		getTracking,
		putMedia,
		recordEvent,
		searchLocalMedia
	} from '$lib/client/idb';
	import { sync } from '$lib/client/sync/engine.svelte';
	import { mediaRecordFromSearch, type SearchLikeMedia } from '$lib/tracking/media-record';
	import { tabs } from '$lib/state/tabs.svelte.js';
	import { tmdbMediaId, type TrackingStatus } from '$lib/sync/events';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import XIcon from '@lucide/svelte/icons/x';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Tracked-status lookup (mediaId → status) so each search row can show whether it's on a list,
	// refreshed after our own writes and after any sync pull applies remote changes.
	let tracked = $state<Map<string, TrackingStatus>>(new Map());
	const writing = new SvelteSet<string>();
	$effect(() => {
		void sync.revision;
		refreshTracked();
	});
	async function refreshTracked() {
		const rows = await getTracking();
		tracked = new Map(rows.map((r) => [r.mediaId, r.status]));
	}

	async function quickAdd(item: SearchLikeMedia) {
		const id = tmdbMediaId(item.type, item.tmdbId);
		if (writing.has(id)) return;
		writing.add(id);
		try {
			// Cache the media locally (offline render + identity for the media channel to hydrate),
			// then record the add — mirrors TrackingState.add()'s pipeline. `$state.snapshot` unwraps
			// the record from any Svelte proxy (offline results are `$state`) so IndexedDB's structured
			// clone doesn't throw "Proxy object could not be cloned".
			await putMedia($state.snapshot(mediaRecordFromSearch(item)));
			await recordEvent('tracking.added', id, { status: 'want_to_watch' });
			sync.requestSync();
			await refreshTracked();
		} finally {
			writing.delete(id);
		}
	}

	async function quickRemove(item: SearchLikeMedia) {
		const id = tmdbMediaId(item.type, item.tmdbId);
		if (writing.has(id)) return;
		writing.add(id);
		try {
			// Only offered for "want to watch" (no episode watches to clear), so a plain tombstone.
			await recordEvent('tracking.removed', id, {});
			sync.requestSync();
			await refreshTracked();
		} finally {
			writing.delete(id);
		}
	}

	// Local-only search history (device IndexedDB, never synced) — shown before the user types.
	let recentSearches = $state<string[]>([]);
	onMount(() => {
		void getRecentSearches().then((r) => (recentSearches = r));
	});
	async function recordSearch(q: string) {
		recentSearches = await addRecentSearch(q);
	}
	async function selectRecentSearch(q: string) {
		query = q;
		await commit();
		await recordSearch(q);
	}
	async function clearHistory() {
		await clearRecentSearches();
		recentSearches = [];
	}

	const DEBOUNCE_MS = 300;

	// Local input value, seeded once from the URL (untrack marks the initial read as intentional).
	// Results come from `data` (the URL is the source of truth); typing pushes the query into
	// `?q=`, which re-runs the server load. afterNavigate re-syncs on back/forward.
	let query = $state(untrack(() => data.q));
	let searching = $state(false);
	let searchInput = $state<HTMLInputElement | null>(null);

	// The Search tab focuses this field — on arrival from another destination, and immediately when
	// it's tapped while already here. The request is a counter rather than a flag so repeated taps
	// re-fire and it doesn't matter whether it was raised before or after this page mounted; tracking
	// the one we served means reaching /search any other way (a deep link, Back from a title) never
	// steals focus or pops the soft keyboard.
	let servedFocus = 0;
	$effect(() => {
		const request = tabs.searchFocusRequest;
		const el = searchInput;
		if (!el || request === servedFocus) return;
		servedFocus = request;
		el.focus();
		el.select();
	});

	let debounce: ReturnType<typeof setTimeout> | undefined;
	// Guards the loading flag against overlapping commits — only the latest clears it.
	let commitSeq = 0;

	const online = $derived(sync.online);
	// Offline: the server load can't run, so search the local IndexedDB catalog (the user's own
	// titles) reactively as they type. Online results still come from `data` (TMDB / shared library).
	let offlineResults = $state<SearchLikeMedia[]>([]);
	let offlineSearching = $state(false);
	let offlineSeq = 0;
	let offlineDebounce: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		const q = query.trim();
		if (sync.online) {
			clearTimeout(offlineDebounce);
			offlineSearching = false;
			return;
		}
		clearTimeout(offlineDebounce);
		if (!q) {
			offlineResults = [];
			offlineSearching = false;
			return;
		}
		// Show the skeleton while the debounced local search runs, so we don't flash "no results"
		// before it has actually looked (mirrors the online path's `searching`).
		offlineSearching = true;
		offlineDebounce = setTimeout(() => {
			const seq = ++offlineSeq;
			searchLocalMedia(q).then((r) => {
				if (seq === offlineSeq) {
					offlineResults = r;
					offlineSearching = false;
				}
			});
		}, DEBOUNCE_MS);
	});
	// When connectivity returns, commit whatever was typed offline: offline typing never reaches the
	// URL (onInput bails), so without this the list would snap back to the stale `?q=` results and the
	// user's offline query would be lost until they edited the box.
	let wasOnline = sync.online;
	$effect(() => {
		const nowOnline = sync.online;
		if (nowOnline && !wasOnline && untrack(() => query.trim()) !== untrack(() => data.q))
			void commit();
		wasOnline = nowOnline;
	});
	// The active result set + the query/mode that drive the list and the degraded/offline banner.
	const results = $derived<SearchLikeMedia[]>(online ? data.results : offlineResults);
	// Loading = the online commit is in flight, or the offline local search is still running.
	const loading = $derived(searching || offlineSearching);
	const activeQuery = $derived(online ? data.q : query.trim());
	const networkMode = $derived<'up' | 'down' | 'offline'>(
		!online ? 'offline' : data.degraded ? 'down' : 'up'
	);

	// Re-sync the input when the URL changes outside of typing (back/forward, direct load) so a
	// restored `?q=` shows up in the box. Skip our own `goto` navigations (nav.type === 'goto').
	afterNavigate((nav) => {
		if (nav.type === 'popstate' || nav.type === 'enter') query = data.q;
	});

	function pushQuery(q: string) {
		const path = resolve('/search');
		const target = q ? `${path}?q=${encodeURIComponent(q)}` : path;
		// The path is resolved; appending a query string drops resolve()'s branded type, which the
		// rule keys on, and it has no escape for query-string navigation — so disable it here.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		return goto(target, { replaceState: true, keepFocus: true, noScroll: true });
	}

	async function commit() {
		const q = query.trim();
		// Offline we don't navigate (the server load would fail) — the reactive effect already
		// debounced + refreshed `offlineResults` from the local catalog.
		if (!online) return;
		const seq = ++commitSeq;
		// Only show the skeleton for an actual search — clearing shouldn't flash a loading state.
		searching = q.length > 0;
		try {
			await pushQuery(q);
		} finally {
			// Always clear the skeleton, even if the navigation rejects (e.g. connectivity drops
			// mid-commit) — otherwise the loading state would stick on screen.
			if (seq === commitSeq) searching = false;
		}
	}

	function onInput() {
		clearTimeout(debounce);
		if (!online) return; // offline results come from the reactive local-search effect
		debounce = setTimeout(commit, DEBOUNCE_MS);
	}

	function clearSearch() {
		clearTimeout(debounce);
		query = '';
		commit();
		searchInput?.focus();
	}

	// Record to history once the user settles on a query (Enter, or leaving the field) rather than on
	// every keystroke the live-search debounce reacts to — `recordSearch` itself ignores blanks.
	function onSearchKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') void recordSearch(query);
	}
	function onSearchBlur() {
		void recordSearch(query);
	}
</script>

<svelte:head>
	<title>Search · Marquee</title>
</svelte:head>

<!-- No back control: this is a tab root. The search field sits where a page title would, and its
h-10 holds the header at the same height as the other pages'. -->
<PageHeader>
	<div class="flex items-center gap-3">
		<div class="relative flex-1">
			<!-- `glass`: the same frosted material as the tab bar. The field sits in a sticky header that
			results scroll beneath, so it needs the tint and wash for the same reason the bar does. -->
			<Input
				bind:ref={searchInput}
				type="search"
				bind:value={query}
				oninput={onInput}
				onkeydown={onSearchKeydown}
				onblur={onSearchBlur}
				placeholder="Search movies and shows"
				aria-label="Search movies and shows"
				autocomplete="off"
				autocapitalize="none"
				class="glass appearance-none pr-11 [&::-webkit-search-cancel-button]:appearance-none"
			/>
			{#if query}
				<button
					type="button"
					onclick={clearSearch}
					aria-label="Clear search"
					class="absolute top-1/2 right-2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
				>
					<XIcon class="size-4" />
				</button>
			{/if}
		</div>
	</div>
</PageHeader>

<main class="mx-auto flex w-full max-w-2xl flex-col gap-4 px-5 pt-3 pb-tab-bar">
	{#if loading}
		<ul class="flex flex-col gap-3">
			{#each [0, 1, 2, 3] as i (i)}
				<li class="flex items-center gap-3">
					<Skeleton class="aspect-[2/3] w-12 rounded-sm" />
					<div class="flex flex-1 flex-col gap-2">
						<Skeleton class="h-4 w-1/2" />
						<Skeleton class="h-3 w-1/4" />
					</div>
				</li>
			{/each}
		</ul>
	{:else}
		{#if !activeQuery && recentSearches.length > 0}
			<div class="flex flex-col gap-2">
				<div class="flex items-center justify-between">
					<h2 class="text-sm font-medium text-muted-foreground">Recent searches</h2>
					<Button variant="ghost" size="sm" onclick={clearHistory}>Clear</Button>
				</div>
				<ul class="flex flex-col gap-1">
					{#each recentSearches as q (q)}
						<li>
							<button
								type="button"
								onclick={() => selectRecentSearch(q)}
								class="flex w-full items-center gap-3 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-secondary"
							>
								<ClockIcon class="size-4 shrink-0 text-muted-foreground" />
								<span class="truncate">{q}</span>
							</button>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
		{#if networkMode !== 'up' && activeQuery}
			<!-- Degraded/offline banner: TMDB unreachable → shared library; offline → your own titles. -->
			<p
				data-spec-ref="search-degraded-offline-banner"
				class="rounded-sm bg-secondary px-3 py-2.5 text-sm text-muted-foreground"
			>
				{networkMode === 'offline'
					? "You're offline — showing titles from your own list only."
					: 'TMDB is unreachable — showing results from the shared library only.'}
			</p>
		{/if}
		{#if activeQuery && results.length === 0}
			<p class="px-1 py-6 text-center text-sm text-muted-foreground">
				No movies or shows found for “{activeQuery}”.
			</p>
		{/if}
	{/if}
	{#if !loading && results.length > 0}
		<ul class="flex flex-col gap-1">
			{#each results as item (item.type + item.tmdbId)}
				{@const id = tmdbMediaId(item.type, item.tmdbId)}
				<li class="flex items-center gap-1">
					<a
						href={resolve('/title/[type]/[id]', { type: item.type, id: String(item.tmdbId) })}
						class="-ml-2 flex min-w-0 flex-1 items-center gap-3 rounded-sm px-2 py-1.5 transition-colors hover:bg-secondary"
					>
						<div class="w-12 shrink-0">
							<PosterTile
								type={item.type}
								posterUrl={posterUrl(item.posterPath)}
								alt={item.title}
							/>
						</div>
						<div class="flex min-w-0 flex-1 flex-col gap-1">
							<span class="truncate font-medium">{item.title}</span>
							<div class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
								<MediaTypeLabel type={item.type} year={item.year} />
								{#if tracked.get(id) === 'did_not_finish'}
									<span class="text-xs">Didn't finish</span>
								{/if}
							</div>
						</div>
					</a>
					<SearchQuickAdd
						title={item.title}
						status={tracked.get(id)}
						busy={writing.has(id)}
						onadd={() => quickAdd(item)}
						onremove={() => quickRemove(item)}
					/>
				</li>
			{/each}
		</ul>
	{/if}
</main>
