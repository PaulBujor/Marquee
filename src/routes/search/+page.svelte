<script lang="ts">
	import { afterNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import MediaBadge from '$lib/components/media/media-badge.svelte';
	import PosterTile from '$lib/components/media/poster-tile.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { focusFirstInput } from '$lib/utils.js';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import XIcon from '@lucide/svelte/icons/x';

	/** Matches the normalized shape returned by `/api/search` (see src/lib/server/tmdb/types.ts). */
	type SearchResult = {
		tmdbId: number;
		type: 'movie' | 'show';
		title: string;
		year: number | null;
		posterPath: string | null;
		overview: string;
	};

	const DEBOUNCE_MS = 300;

	let query = $state('');
	let results = $state<SearchResult[]>([]);
	let loading = $state(false);
	let errored = $state(false);
	let hasSearched = $state(false);
	let searchInput = $state<HTMLInputElement | null>(null);

	let debounce: ReturnType<typeof setTimeout> | undefined;
	let inFlight: AbortController | undefined;

	// Autofocus the search box on mount so the user can type straight away.
	$effect(() => focusFirstInput(searchInput));

	// Pop history so Search doesn't stack a duplicate `/` entry; fall back to home
	// when opened directly (no in-app history to pop). Mirrors the Settings page.
	let cameFromApp = $state(false);
	afterNavigate((nav) => {
		cameFromApp = nav.from != null;
	});

	function goBack() {
		if (cameFromApp) history.back();
		else goto(resolve('/'));
	}

	function clearSearch() {
		clearTimeout(debounce);
		query = '';
		run('');
		searchInput?.focus();
	}

	function posterUrl(path: string | null): string | null {
		return path ? `https://image.tmdb.org/t/p/w342${path}` : null;
	}

	async function run(q: string) {
		inFlight?.abort();
		const trimmed = q.trim();
		if (!trimmed) {
			results = [];
			loading = false;
			errored = false;
			hasSearched = false;
			return;
		}

		const controller = new AbortController();
		inFlight = controller;
		loading = true;
		errored = false;
		hasSearched = true;

		try {
			const res = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
				signal: controller.signal
			});
			if (!res.ok) throw new Error(`search failed: ${res.status}`);
			const data = (await res.json()) as { results: SearchResult[] };
			results = data.results;
		} catch {
			if (controller.signal.aborted) return; // superseded by a newer keystroke
			results = [];
			errored = true;
		} finally {
			if (!controller.signal.aborted) loading = false;
		}
	}

	function onInput() {
		clearTimeout(debounce);
		debounce = setTimeout(() => run(query), DEBOUNCE_MS);
	}
</script>

<svelte:head>
	<title>Search · Marquee</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-2xl flex-col gap-4 px-5 pb-10">
	<div class="flex items-center gap-3">
		<Button
			onclick={goBack}
			variant="outline"
			size="icon"
			shape="round"
			class="text-muted-foreground"
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
			class="pr-9 [&::-webkit-search-cancel-button]:appearance-none"
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

	{#if loading}
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
	{:else if errored}
		<p
			data-spec-ref="search-degraded-offline-banner"
			class="rounded-[10px] bg-secondary px-3 py-2.5 text-sm text-muted-foreground"
		>
			Search is unavailable right now. Please try again shortly.
		</p>
	{:else if hasSearched && results.length === 0}
		<p class="px-1 py-6 text-center text-sm text-muted-foreground">
			No movies or shows found for “{query.trim()}”.
		</p>
	{:else if results.length > 0}
		<ul class="flex flex-col gap-1">
			{#each results as item (item.type + item.tmdbId)}
				<li class="flex items-center gap-3 py-1.5">
					<div class="w-12 shrink-0">
						<PosterTile
							type={item.type}
							posterUrl={posterUrl(item.posterPath)}
							title={item.title}
						/>
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
	{:else}
		<p class="px-1 py-6 text-center text-sm text-muted-foreground">
			Search for a movie or show to get started.
		</p>
	{/if}
</main>
