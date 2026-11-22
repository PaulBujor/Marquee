<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { afterNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import PageHeader from '#lib/components/page-header.svelte';
	import MediaTypeLabel from '#lib/components/media/media-type-label.svelte';
	import PersonAvatar from '#lib/components/media/person-avatar.svelte';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import PosterTile from '#lib/components/media/poster-tile.svelte';
	import SearchQuickAdd from '#lib/components/media/search-quick-add.svelte';
	import CustomMediaForm from '#lib/components/media/custom-media-form.svelte';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { posterUrl } from '#lib/media.js';
	import {
		addRecentSearch,
		clearRecentSearches,
		getRecentSearches,
		getTracking,
		putCustomMedia,
		putMedia,
		recordEvent,
		searchCustomMedia,
		searchLocalMedia,
		type ClientMedia
	} from '#lib/client/idb/index.js';
	import { sync } from '#lib/client/sync/engine.svelte.js';
	import { guardedWrite } from '#lib/client/write-guard.js';
	import { createCustomMedia } from '#lib/custom-media.js';
	import { mediaRecordFromSearch, type SearchLikeMedia } from '#lib/tracking/media-record.js';
	import type { CustomMediaInput } from '#lib/validation/custom-media.js';
	import type { SearchResult } from '#lib/server/tmdb/index.js';
	import { tabs } from '#lib/state/tabs.svelte.js';
	import { tmdbMediaId, type TrackingStatus } from '#lib/sync/events.js';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import Link2Icon from '@lucide/svelte/icons/link-2';
	import XIcon from '@lucide/svelte/icons/x';
	import type { PageData } from './$types';
	import { navigate } from '#lib/client/navigate.js';

	let { data }: { data: PageData } = $props();

	let tracked = $state<Map<string, TrackingStatus>>(new Map());
	const writing = new SvelteSet<string>();
	$effect(() => {
		if (!data.user) return;
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
			// `$state.snapshot` unwraps the record (offline results are `$state`) or IndexedDB's clone throws "Proxy object could not be cloned".
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

	// Searched locally in every mode: nothing upstream has ever heard of a custom entry, so this is the only route to one.
	let customResults = $state<ClientMedia[]>([]);
	let customSeq = 0;
	$effect(() => {
		const q = query.trim();
		void sync.revision;
		if (!q) {
			customResults = [];
			return;
		}
		const seq = ++customSeq;
		void searchCustomMedia(q).then((r) => {
			if (seq === customSeq) customResults = r;
		});
	});

	let createOpen = $state(false);
	let createType = $state<'movie' | 'show'>('movie');
	let creating = $state(false);

	async function createCustom(input: CustomMediaInput) {
		if (creating) return;
		creating = true;
		const record = createCustomMedia(input);
		// Guarded: a local write can fail invisibly, which would close the dialog on an entry that was never saved.
		const ok = await guardedWrite(
			async () => {
				// Same pipeline via the authoring write: it stamps the edit clock and queues the record for backup.
				await putCustomMedia(record);
				await recordEvent('tracking.added', record.id, { status: 'want_to_watch' });
			},
			{ source: 'custom-media:create', userMessage: "Couldn't add that entry" }
		);
		creating = false;
		if (!ok) return; // the dialog stays open with the user's input intact

		sync.requestSync();
		await refreshTracked();
		createOpen = false;
		await goto(resolve('/custom/[id]', { id: record.id }));
	}

	// Device IndexedDB only, never synced.
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

	let query = $state(untrack(() => data.q));
	let searching = $state(false);
	let searchInput = $state<HTMLInputElement | null>(null);

	// A counter, not a flag: repeated taps re-fire, and arriving any other way (deep link, Back) never steals focus.
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
	let commitSeq = 0;

	const online = $derived(sync.online);
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
	// Offline typing never reaches the URL, so on reconnect the typed query would otherwise snap back to a stale `?q=`.
	let wasOnline = sync.online;
	$effect(() => {
		const nowOnline = sync.online;
		if (nowOnline && !wasOnline && untrack(() => query.trim()) !== untrack(() => data.q))
			void commit();
		wasOnline = nowOnline;
	});
	const results = $derived<SearchResult[]>(
		online
			? data.results
			: offlineResults.map((media) => ({
					kind: 'media' as const,
					...media,
					// `overview` is optional locally but required on a search result; a blank one would be stored by a quick-add.
					overview: media.overview ?? ''
				}))
	);

	// Local state, not the URL: a URL tab would re-run the load and re-hit TMDB just to hide rows.
	type ResultTab = 'all' | 'titles' | 'people';
	const RESULT_TABS: { key: ResultTab; label: string }[] = [
		{ key: 'all', label: 'All' },
		{ key: 'titles', label: 'Titles' },
		{ key: 'people', label: 'People' }
	];
	let resultTab = $state<ResultTab>('all');

	const mediaResults = $derived(results.filter((r) => r.kind === 'media'));
	const peopleResults = $derived(results.filter((r) => r.kind === 'person'));
	const visibleResults = $derived(
		resultTab === 'titles' ? mediaResults : resultTab === 'people' ? peopleResults : results
	);
	const visibleCustom = $derived(resultTab === 'people' ? [] : customResults);
	const nothingFound = $derived(results.length === 0 && customResults.length === 0);
	const loading = $derived(searching || offlineSearching);
	const activeQuery = $derived(online ? data.q : query.trim());
	const networkMode = $derived<'up' | 'down' | 'offline'>(
		!online ? 'offline' : data.degraded ? 'down' : 'up'
	);

	afterNavigate((nav) => {
		if (nav.shallow && nav.type === 'goto') return;
		if (nav.type === 'popstate' || nav.type === 'enter') query = data.q;
	});

	function pushQuery(q: string) {
		const path = resolve('search');
		const target = q ? `${path}?q=${encodeURIComponent(q)}` : path;
		return navigate(target, { replace: true, reset: false });
	}

	async function commit() {
		const q = query.trim();
		// Offline there's nothing to navigate to: the server load would fail, and the effect already searched locally.
		if (!online) return;
		const seq = ++commitSeq;
		searching = q.length > 0;
		try {
			await pushQuery(q);
		} finally {
			// Clear even if the navigation rejects (connectivity can drop mid-commit), or the skeleton sticks.
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

<!-- No back control: tab root. The field's h-10 keeps the header the same height as other pages'. -->
<PageHeader>
	<div class="flex items-center gap-3">
		<div class="relative flex-1">
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

<main class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 pt-3 pb-tab-bar">
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
			<p
				data-spec-ref="search-degraded-offline-banner"
				class="rounded-sm bg-secondary px-3 py-2.5 text-sm text-muted-foreground"
			>
				{networkMode === 'offline'
					? "You're offline — showing titles from your own list only."
					: 'TMDB is unreachable — showing results from the shared library only.'}
			</p>
		{/if}
		{#if activeQuery && nothingFound}
			<p class="px-1 py-6 text-center text-sm text-muted-foreground">
				Nothing found for “{activeQuery}”.
			</p>
		{/if}
	{/if}

	{#if !loading && !nothingFound}
		<Tabs.Root bind:value={resultTab}>
			<Tabs.List class="w-full">
				{#each RESULT_TABS as t (t.key)}
					<Tabs.Trigger value={t.key}>{t.label}</Tabs.Trigger>
				{/each}
			</Tabs.List>
		</Tabs.Root>

		{#if visibleCustom.length > 0}
			<div class="flex flex-col gap-2">
				<h2 class="text-sm font-medium text-muted-foreground">Your entries</h2>
				<ul class="flex flex-col gap-1">
					{#each visibleCustom as entry (entry.id)}
						<li>
							<a
								href={resolve('/custom/[id]', { id: entry.id })}
								class="-mx-2 flex min-w-0 items-center gap-3 rounded-sm px-2 py-1.5 transition-colors hover:bg-secondary"
							>
								<div class="w-12 shrink-0">
									<PosterTile type={entry.type} posterUrl={null} alt={entry.title} isCustom />
								</div>
								<div class="flex min-w-0 flex-1 flex-col gap-1">
									<span class="truncate font-medium">{entry.title}</span>
									<div class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
										<MediaTypeLabel type={entry.type} year={entry.year} />
										{#if tracked.get(entry.id) === undefined}
											<span class="text-xs">Not on a list</span>
										{/if}
									</div>
								</div>
							</a>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if visibleResults.length === 0 && visibleCustom.length === 0}
			<p class="px-1 py-6 text-center text-sm text-muted-foreground">
				{#if resultTab === 'people' && networkMode !== 'up'}
					People need a connection — only your own titles are searchable right now.
				{:else if resultTab === 'people'}
					No people found for “{activeQuery}”.
				{:else}
					No movies or shows found for “{activeQuery}”.
				{/if}
			</p>
		{:else if visibleResults.length > 0}
			<ul class="flex flex-col gap-1">
				{#each visibleResults as item (item.kind === 'person' ? `p${item.tmdbId}` : `${item.type}${item.tmdbId}`)}
					{#if item.kind === 'person'}
						<li>
							<a
								href={resolve('/person/[id]', { id: String(item.tmdbId) })}
								class="-mx-2 flex min-w-0 items-center gap-3 rounded-sm px-2 py-1.5 transition-colors hover:bg-secondary"
							>
								<PersonAvatar
									name={item.name}
									profilePath={item.profilePath}
									class="size-12 shrink-0"
								/>
								<div class="flex min-w-0 flex-1 flex-col gap-1">
									<span class="truncate font-medium">{item.name}</span>
									<span class="truncate text-sm text-muted-foreground">
										{[item.department, item.knownFor.slice(0, 2).join(', ')]
											.filter(Boolean)
											.join(' · ') || 'Person'}
									</span>
								</div>
							</a>
						</li>
					{:else}
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
					{/if}
				{/each}
			</ul>
		{/if}
	{/if}

	{#if !loading && activeQuery}
		<!-- The escape hatch for a title no database carries: offered even on a near-miss, the usual reason to reach for it. -->
		<div class="mt-2 flex flex-col gap-3 border-t border-dashed border-border pt-4">
			<p class="text-sm text-muted-foreground">Can't find it?</p>
			<ToggleGroup.Root
				type="single"
				value={createType}
				onValueChange={(v) => (createType = ((v as string) || createType) as 'movie' | 'show')}
				variant="outline"
				size="sm"
				class="self-start"
			>
				<ToggleGroup.Item value="movie" class="rounded-l-full!">Movie</ToggleGroup.Item>
				<ToggleGroup.Item value="show" class="rounded-r-full!">Show</ToggleGroup.Item>
			</ToggleGroup.Root>

			<Button variant="outline" class="w-full" onclick={() => (createOpen = true)}>
				<Link2Icon class="size-4" />
				Add “{activeQuery}” manually
			</Button>
		</div>
	{/if}
</main>

<CustomMediaForm
	bind:open={createOpen}
	initialTitle={activeQuery}
	initialType={createType}
	busy={creating}
	onsubmit={createCustom}
/>
