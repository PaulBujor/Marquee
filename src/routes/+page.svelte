<script lang="ts">
	import { resolve } from '$app/paths';
	import { buttonVariants } from '$lib/components/ui/button';
	import PosterTile from '$lib/components/media/poster-tile.svelte';
	import ProgressRing from '$lib/components/media/progress-ring.svelte';
	import { LibraryState } from '$lib/tracking/library.svelte';
	import { sync } from '$lib/client/sync/engine.svelte';
	import {
		availableGenres,
		availableYears,
		continueWatching,
		filterAndSortLibrary,
		showProgress,
		type LibrarySort,
		type LibraryTab
	} from '$lib/tracking/library';
	import CheckIcon from '@lucide/svelte/icons/check';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// The home library reads local IndexedDB (works offline); reloads whenever a sync pulls.
	const library = new LibraryState();
	$effect(() => {
		void sync.revision;
		library.load();
	});

	const TABS: { key: LibraryTab; label: string }[] = [
		{ key: 'want_to_watch', label: 'Want to Watch' },
		{ key: 'watching', label: 'Watching' },
		{ key: 'completed', label: 'Completed' },
		{ key: 'favorites', label: 'Favorites' }
	];
	const TYPES: { key: 'all' | 'movie' | 'show'; label: string }[] = [
		{ key: 'all', label: 'All' },
		{ key: 'movie', label: 'Movies' },
		{ key: 'show', label: 'Shows' }
	];

	let tab = $state<LibraryTab>('want_to_watch');
	let typeFilter = $state<'all' | 'movie' | 'show'>('all');
	let year = $state<number | null>(null);
	let genre = $state<string | null>(null);
	let sort = $state<LibrarySort>('added');
	let filtersOpen = $state(false);

	const inProgress = $derived(continueWatching(library.items));
	const years = $derived(availableYears(library.items));
	const genres = $derived(availableGenres(library.items));
	const list = $derived(
		filterAndSortLibrary(library.items, { tab, type: typeFilter, year, genre, sort })
	);
	const hasFilters = $derived(year !== null || genre !== null);
</script>

<svelte:head><title>Marquee</title></svelte:head>

{#if data.user}
	<main class="mx-auto w-full max-w-2xl px-5 pb-16">
		<!-- Continue watching — in-progress shows only (movies have no next episode) -->
		{#if inProgress.length > 0}
			<section class="mb-7">
				<h2 class="mb-2.5 text-xs font-bold tracking-widest text-muted-foreground uppercase">
					Continue Watching
				</h2>
				<div class="no-scrollbar flex gap-3 overflow-x-auto pb-1">
					{#each inProgress as item (item.mediaId)}
						{@const progress = showProgress(item)}
						{#if progress?.next}
							<div class="w-28 shrink-0">
								<div class="relative">
									<a
										href={resolve('/title/[type]/[id]', {
											type: item.type,
											id: item.externalId?.split('/')[1] ?? ''
										})}
										aria-label={item.title}
									>
										<PosterTile
											type="show"
											mediaId={item.mediaId}
											posterPath={item.posterPath}
											alt={item.title}
										/>
									</a>
									<button
										type="button"
										onclick={() => library.markNext(item)}
										disabled={library.busy}
										aria-label={`Mark S${progress.next.season} E${progress.next.episode} of ${item.title} watched`}
										class="absolute right-1.5 bottom-1.5 flex size-9 items-center justify-center rounded-full bg-black/60 text-white disabled:opacity-60"
									>
										<ProgressRing progress={progress.fraction} size={34} class="absolute" />
										<CheckIcon class="size-3.5" />
									</button>
								</div>
								<div class="mt-1.5 truncate text-xs font-medium">{item.title}</div>
								<div class="text-[0.7rem] text-muted-foreground">
									S{progress.next.season} · E{progress.next.episode}
								</div>
							</div>
						{/if}
					{/each}
				</div>
			</section>
		{/if}

		<!-- Tabs -->
		<div class="mb-3 flex gap-1.5">
			{#each TABS as t (t.key)}
				<button
					type="button"
					onclick={() => (tab = t.key)}
					aria-pressed={tab === t.key}
					class="flex-1 rounded-full border px-2 py-2 text-xs font-semibold transition-colors {tab ===
					t.key
						? 'border-primary bg-primary text-primary-foreground'
						: 'border-border text-muted-foreground hover:text-foreground'}"
				>
					{t.label}
				</button>
			{/each}
		</div>

		<!-- Type filter + Filters/sort disclosure -->
		<div class="mb-3 flex items-center gap-1.5">
			{#each TYPES as t (t.key)}
				<button
					type="button"
					onclick={() => (typeFilter = t.key)}
					aria-pressed={typeFilter === t.key}
					class="rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors {typeFilter ===
					t.key
						? 'border-primary text-primary'
						: 'border-border text-muted-foreground hover:text-foreground'}"
				>
					{t.label}
				</button>
			{/each}
			<button
				type="button"
				onclick={() => (filtersOpen = !filtersOpen)}
				aria-expanded={filtersOpen}
				class="ml-auto rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors {filtersOpen ||
				hasFilters
					? 'border-primary text-primary'
					: 'border-border text-muted-foreground hover:text-foreground'}"
			>
				Filters &amp; sort
			</button>
		</div>

		{#if filtersOpen}
			<div class="mb-4 flex flex-wrap gap-3 rounded-xl bg-secondary/40 p-3 text-sm">
				<label class="flex items-center gap-2">
					<span class="text-xs font-medium text-muted-foreground">Sort</span>
					<select bind:value={sort} class="rounded-md border border-border bg-background px-2 py-1">
						<option value="added">Date added</option>
						<option value="title">Title</option>
						<option value="year">Release year</option>
					</select>
				</label>
				<label class="flex items-center gap-2">
					<span class="text-xs font-medium text-muted-foreground">Year</span>
					<select
						value={year ?? ''}
						onchange={(e) => (year = e.currentTarget.value ? Number(e.currentTarget.value) : null)}
						class="rounded-md border border-border bg-background px-2 py-1"
					>
						<option value="">Any</option>
						{#each years as y (y)}
							<option value={y}>{y}</option>
						{/each}
					</select>
				</label>
				<label class="flex items-center gap-2">
					<span class="text-xs font-medium text-muted-foreground">Genre</span>
					<select
						value={genre ?? ''}
						onchange={(e) => (genre = e.currentTarget.value || null)}
						class="rounded-md border border-border bg-background px-2 py-1"
					>
						<option value="">Any</option>
						{#each genres as g (g)}
							<option value={g}>{g}</option>
						{/each}
					</select>
				</label>
			</div>
		{/if}

		<!-- Poster grid -->
		{#if list.length > 0}
			<ul class="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4">
				{#each list as item (item.mediaId)}
					<li>
						<a
							href={resolve('/title/[type]/[id]', {
								type: item.type,
								id: item.externalId?.split('/')[1] ?? ''
							})}
							class="block"
						>
							<PosterTile
								type={item.type}
								mediaId={item.mediaId}
								posterPath={item.posterPath}
								isFavorite={item.favorite}
								alt={item.title}
							/>
							<div class="mt-1.5 truncate text-sm font-medium">{item.title}</div>
							{#if item.year}<div class="text-xs text-muted-foreground">{item.year}</div>{/if}
						</a>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="py-16 text-center text-sm text-muted-foreground">
				{library.ready ? 'Nothing here yet.' : 'Loading…'}
			</p>
		{/if}
	</main>
{:else}
	<main class="mx-auto flex min-h-svh max-w-2xl flex-col items-start justify-center gap-4 p-6">
		<h1 class="font-serif text-3xl font-semibold">Marquee</h1>
		<p class="text-muted-foreground">Track the movies and shows you're watching.</p>
		<!-- Replace the index in history so, after login redirects back here, Back doesn't
		bounce through /login or a stale signed-out landing page. -->
		<a href={resolve('/login')} data-sveltekit-replacestate class={buttonVariants()}>Sign in</a>
	</main>
{/if}
