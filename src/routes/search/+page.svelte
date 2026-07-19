<script lang="ts">
	import { untrack } from 'svelte';
	import { afterNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import MediaBadge from '$lib/components/media/media-badge.svelte';
	import PosterTile from '$lib/components/media/poster-tile.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { posterUrl } from '$lib/media.js';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import XIcon from '@lucide/svelte/icons/x';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const DEBOUNCE_MS = 300;

	// Local input value, seeded once from the URL (untrack marks the initial read as intentional).
	// Results come from `data` (the URL is the source of truth); typing pushes the query into
	// `?q=`, which re-runs the server load. afterNavigate re-syncs on back/forward.
	let query = $state(untrack(() => data.q));
	let searching = $state(false);
	let searchInput = $state<HTMLInputElement | null>(null);

	let debounce: ReturnType<typeof setTimeout> | undefined;
	// Guards the loading flag against overlapping commits — only the latest clears it.
	let commitSeq = 0;

	// Re-sync the input when the URL changes outside of typing (back/forward, direct load) so a
	// restored `?q=` shows up in the box. Skip our own `goto` navigations (nav.type === 'goto').
	// Also track whether we can pop history for the back button (mirrors the Settings page).
	let cameFromApp = $state(false);
	afterNavigate((nav) => {
		cameFromApp = nav.from != null;
		if (nav.type === 'popstate' || nav.type === 'enter') query = data.q;
	});

	function goBack() {
		if (cameFromApp) history.back();
		else goto(resolve('/'));
	}

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
		const seq = ++commitSeq;
		// Only show the skeleton for an actual search — clearing shouldn't flash a loading state.
		searching = q.length > 0;
		await pushQuery(q);
		if (seq === commitSeq) searching = false;
	}

	function onInput() {
		clearTimeout(debounce);
		debounce = setTimeout(commit, DEBOUNCE_MS);
	}

	function clearSearch() {
		clearTimeout(debounce);
		query = '';
		commit();
		searchInput?.focus();
	}
</script>

<svelte:head>
	<title>Search · Marquee</title>
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
		<h1 class="font-serif text-2xl font-semibold">Search</h1>
	</div>

	<div class="relative">
		<Input
			bind:ref={searchInput}
			type="search"
			bind:value={query}
			oninput={onInput}
			placeholder="Search movies and shows"
			aria-label="Search movies and shows"
			autocomplete="off"
			autocapitalize="none"
			class="h-8 appearance-none pr-9 [&::-webkit-search-cancel-button]:appearance-none"
		/>
		{#if query}
			<button
				type="button"
				onclick={clearSearch}
				aria-label="Clear search"
				class="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
			>
				<XIcon class="size-4" />
			</button>
		{/if}
	</div>

	{#if searching}
		<ul class="flex flex-col gap-3">
			{#each [0, 1, 2, 3] as i (i)}
				<li class="flex items-center gap-3">
					<Skeleton class="aspect-[2/3] w-12 rounded-[10px]" />
					<div class="flex flex-1 flex-col gap-2">
						<Skeleton class="h-4 w-1/2" />
						<Skeleton class="h-3 w-1/4" />
					</div>
				</li>
			{/each}
		</ul>
	{:else if data.failed}
		<p
			data-spec-ref="search-degraded-offline-banner"
			class="rounded-[10px] bg-secondary px-3 py-2.5 text-sm text-muted-foreground"
		>
			Search is unavailable right now. Please try again shortly.
		</p>
	{:else if data.q && data.results.length === 0}
		<p class="px-1 py-6 text-center text-sm text-muted-foreground">
			No movies or shows found for “{data.q}”.
		</p>
	{:else if data.results.length > 0}
		<ul class="flex flex-col gap-1">
			{#each data.results as item (item.type + item.tmdbId)}
				<li class="flex items-center gap-3 py-1.5">
					<div class="w-12 shrink-0">
						<PosterTile type={item.type} posterUrl={posterUrl(item.posterPath)} alt={item.title} />
					</div>
					<div class="flex min-w-0 flex-1 flex-col gap-1">
						<span class="truncate font-medium">{item.title}</span>
						<div class="flex items-center gap-2 text-sm text-muted-foreground">
							<MediaBadge>{item.type === 'movie' ? 'Movie' : 'Show'}</MediaBadge>
							{#if item.year}<span>{item.year}</span>{/if}
						</div>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</main>
