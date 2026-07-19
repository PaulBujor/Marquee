<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import MediaBadge from '$lib/components/media/media-badge.svelte';
	import PosterTile from '$lib/components/media/poster-tile.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { search } from '$lib/state/search.svelte.js';
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
	let inputEl = $state<HTMLInputElement | null>(null);
	let panelEl = $state<HTMLElement | null>(null);

	let debounce: ReturnType<typeof setTimeout> | undefined;
	let inFlight: AbortController | undefined;

	// Register refs with the singleton so the header button can focus the input on open.
	$effect(() => {
		search.input = inputEl;
		search.panel = panelEl;
	});

	// Lock body scroll while open; reset the search when it closes so the next open starts fresh.
	$effect(() => {
		if (search.isOpen) {
			document.body.style.overflow = 'hidden';
		} else {
			document.body.style.overflow = '';
			reset();
		}
		return () => {
			document.body.style.overflow = '';
		};
	});

	function reset() {
		clearTimeout(debounce);
		inFlight?.abort();
		query = '';
		results = [];
		loading = false;
		errored = false;
		hasSearched = false;
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

	function clearInput() {
		clearTimeout(debounce);
		query = '';
		run('');
		inputEl?.focus();
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') search.close();
	}
</script>

<!-- Persistent (never behind {#if}) so the input stays in the DOM and `open()` can focus it
within the tap gesture. Hidden with transform + pointer-events + inert — never display/visibility,
which would block that focus. -->
<div
	bind:this={panelEl}
	inert={!search.isOpen}
	onkeydown={onKeydown}
	role="dialog"
	aria-modal="true"
	aria-label="Search movies and shows"
	tabindex={-1}
	class="fixed inset-0 z-50 flex flex-col bg-background transition-transform duration-200 ease-out {search.isOpen
		? 'translate-y-0'
		: 'pointer-events-none translate-y-full'}"
>
	<div class="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 overflow-y-auto px-5 pt-4 pb-10">
		<div class="flex items-center gap-3">
			<Button
				onclick={() => search.close()}
				variant="outline"
				size="icon"
				shape="round"
				class="shrink-0 text-muted-foreground"
				aria-label="Close search"
			>
				<ChevronLeftIcon class="size-4" />
			</Button>
			<div class="relative flex-1">
				<Input
					bind:ref={inputEl}
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
						onclick={clearInput}
						aria-label="Clear search"
						class="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
					>
						<XIcon class="size-4" />
					</button>
				{/if}
			</div>
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
	</div>
</div>
