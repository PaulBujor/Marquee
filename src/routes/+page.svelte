<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { flip } from 'svelte/animate';
	import { SvelteSet } from 'svelte/reactivity';
	import { buttonVariants } from '$lib/components/ui/button';
	import PosterTile from '$lib/components/media/poster-tile.svelte';
	import ProgressRing from '$lib/components/media/progress-ring.svelte';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as Popover from '$lib/components/ui/popover';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import SlidersIcon from '@lucide/svelte/icons/sliders-horizontal';
	import { LibraryState } from '$lib/tracking/library.svelte';
	import { sync } from '$lib/client/sync/engine.svelte';
	import {
		availableGenres,
		availableYears,
		continueWatching,
		filterAndSortLibrary,
		showProgress,
		type LibraryItem,
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

	type TypeFilter = 'all' | 'movie' | 'show';
	interface TabDef {
		key: LibraryTab;
		label: string;
	}
	interface TypeDef {
		key: TypeFilter;
		label: string;
	}
	const TABS: TabDef[] = [
		{ key: 'want_to_watch', label: 'Want to Watch' },
		{ key: 'watching', label: 'Watching' },
		{ key: 'completed', label: 'Completed' },
		{ key: 'favorites', label: 'Favorites' }
	];
	const TYPES: TypeDef[] = [
		{ key: 'all', label: 'All' },
		{ key: 'movie', label: 'Movies' },
		{ key: 'show', label: 'Shows' }
	];

	const SORTS: LibrarySort[] = ['added', 'title', 'year'];

	// Selected tab + filters live in the URL (like the search page), so a view is shareable and
	// survives reload / back-forward. Defaults are omitted from the query to keep it clean.
	function readState() {
		const p = page.url.searchParams;
		const t = p.get('tab');
		const ty = p.get('type');
		const s = p.get('sort');
		const y = p.get('year');
		return {
			tab: (TABS.some((x) => x.key === t) ? t : 'want_to_watch') as LibraryTab,
			typeFilter: (TYPES.some((x) => x.key === ty) ? ty : 'all') as TypeFilter,
			sort: (SORTS.includes(s as LibrarySort) ? s : 'added') as LibrarySort,
			year: y && Number.isFinite(Number(y)) ? Number(y) : null,
			genre: p.get('genre') || null
		};
	}

	const initial = untrack(() => readState());
	let tab = $state<LibraryTab>(initial.tab);
	let typeFilter = $state<TypeFilter>(initial.typeFilter);
	let year = $state<number | null>(initial.year);
	let genre = $state<string | null>(initial.genre);
	let sort = $state<LibrarySort>(initial.sort);

	// Mirror state → URL. Skips when already in sync (so seeding / back-forward don't loop). Built
	// as a plain string (tab/type/sort are enum-safe; genre is encoded) — no URLSearchParams.
	$effect(() => {
		const parts: string[] = [];
		if (tab !== 'want_to_watch') parts.push(`tab=${tab}`);
		if (typeFilter !== 'all') parts.push(`type=${typeFilter}`);
		if (sort !== 'added') parts.push(`sort=${sort}`);
		if (year !== null) parts.push(`year=${year}`);
		if (genre !== null) parts.push(`genre=${encodeURIComponent(genre)}`);
		const qs = parts.join('&');
		const target = qs ? `/?${qs}` : '/';
		if (page.url.pathname === '/' && target !== `${page.url.pathname}${page.url.search}`) {
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- own route + query string
			goto(target, { replaceState: true, keepFocus: true, noScroll: true });
		}
	});

	// Re-seed from the URL on back/forward and direct entry (mirrors the search page).
	afterNavigate((nav) => {
		if (nav.type === 'popstate' || nav.type === 'enter') {
			const s = readState();
			tab = s.tab;
			typeFilter = s.typeFilter;
			sort = s.sort;
			year = s.year;
			genre = s.genre;
		}
	});

	const inProgress = $derived(continueWatching(library.items));
	const years = $derived(availableYears(library.items));
	const genres = $derived(availableGenres(library.items));
	const list = $derived(
		filterAndSortLibrary(library.items, { tab, type: typeFilter, year, genre, sort })
	);
	// Type is surfaced as its own always-visible control; the popover badges when a year/genre
	// narrowing is active (sort is a preference, not a narrowing, so it doesn't count).
	const advancedActive = $derived(year !== null || genre !== null);

	// Quick-mark debounce (mirrors the detail page's next-episode row): fill the check, hold a
	// beat, then mark + advance — so a mis-tap is visible and the card doesn't jump instantly.
	const marking = new SvelteSet<string>();
	function markNextSoon(item: LibraryItem) {
		if (marking.has(item.mediaId) || library.busy) return;
		marking.add(item.mediaId);
		setTimeout(() => {
			marking.delete(item.mediaId);
			library.markNext(item);
		}, 650);
	}

	// When a caught-up show leaves Continue Watching, fade it out and collapse its width at the
	// same time (opacity eased a touch faster so it reads as a fade, not just a shrink); the
	// remaining cards (animate:flip) slide into place concurrently. `t` runs 1→0 on exit.
	function collapse(node: HTMLElement, { duration = 380 } = {}) {
		const width = node.offsetWidth;
		return {
			duration,
			css: (t: number) => `opacity:${t * t};width:${t * width}px;overflow:hidden`
		};
	}
</script>

<svelte:head><title>Marquee</title></svelte:head>

{#if data.user}
	<main class="mx-auto w-full max-w-3xl px-5 pt-2 pb-16">
		<!-- Continue watching — in-progress shows only (movies have no next episode) -->
		{#if inProgress.length > 0}
			<section class="mb-6">
				<h2 class="mb-2.5 text-xs font-bold tracking-widest text-muted-foreground uppercase">
					Continue Watching
				</h2>
				<div class="no-scrollbar flex gap-3 overflow-x-auto pb-1">
					{#each inProgress as item (item.mediaId)}
						{@const progress = showProgress(item)}
						<div class="w-28 shrink-0" animate:flip={{ duration: 320 }} transition:collapse>
							{#if progress?.next}
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
											isFavorite={item.favorite}
											alt={item.title}
										/>
									</a>
									<button
										type="button"
										onclick={() => markNextSoon(item)}
										disabled={library.busy || marking.has(item.mediaId)}
										aria-label={`Mark S${progress.next.season} E${progress.next.episode} of ${item.title} watched`}
										class="absolute right-1.5 bottom-1.5 flex size-9 items-center justify-center rounded-full text-white transition-colors {marking.has(
											item.mediaId
										)
											? 'bg-primary'
											: 'bg-black/60'}"
									>
										{#if !marking.has(item.mediaId)}
											<ProgressRing progress={progress.fraction} size={34} class="absolute" />
										{/if}
										<CheckIcon class="size-3.5" />
									</button>
								</div>
								<div class="mt-1.5 truncate text-xs font-medium">{item.title}</div>
								<div class="text-[0.7rem] text-muted-foreground">
									S{progress.next.season} · E{progress.next.episode}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<!-- Primary navigation: the four lists as tabs -->
		<Tabs.Root bind:value={tab} class="mb-3">
			<Tabs.List class="w-full">
				{#each TABS as t (t.key)}
					<Tabs.Trigger value={t.key}>{t.label}</Tabs.Trigger>
				{/each}
			</Tabs.List>
		</Tabs.Root>

		<!-- Type is the common filter (always visible); year/genre/sort live behind a popover -->
		<div class="mb-4 flex items-center justify-between gap-2">
			<ToggleGroup.Root
				type="single"
				value={typeFilter}
				onValueChange={(v) => (typeFilter = ((v as string) || 'all') as TypeFilter)}
				variant="outline"
				size="sm"
			>
				{#each TYPES as t, i (t.key)}
					<ToggleGroup.Item
						value={t.key}
						class={`${i === 0 ? 'rounded-l-full!' : ''} ${i === TYPES.length - 1 ? 'rounded-r-full!' : ''}`}
					>
						{t.label}
					</ToggleGroup.Item>
				{/each}
			</ToggleGroup.Root>

			<Popover.Root>
				<Popover.Trigger
					class="{buttonVariants({
						variant: advancedActive ? 'default' : 'outline',
						size: 'sm'
					})} gap-1.5"
				>
					<SlidersIcon class="size-4" />
					Filters &amp; sort
				</Popover.Trigger>
				<Popover.Content align="end" class="w-64 space-y-3">
					<label class="flex flex-col gap-1 text-sm">
						<span class="text-xs font-medium text-muted-foreground">Sort</span>
						<select
							bind:value={sort}
							class="h-10 rounded-full border border-border bg-background px-4 transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
						>
							<option value="added">Date added</option>
							<option value="title">Title</option>
							<option value="year">Release year</option>
						</select>
					</label>
					<label class="flex flex-col gap-1 text-sm">
						<span class="text-xs font-medium text-muted-foreground">Year</span>
						<select
							value={year ?? ''}
							onchange={(e) =>
								(year = e.currentTarget.value ? Number(e.currentTarget.value) : null)}
							class="h-10 rounded-full border border-border bg-background px-4 transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
						>
							<option value="">Any</option>
							{#each years as y (y)}
								<option value={y}>{y}</option>
							{/each}
						</select>
					</label>
					<label class="flex flex-col gap-1 text-sm">
						<span class="text-xs font-medium text-muted-foreground">Genre</span>
						<select
							value={genre ?? ''}
							onchange={(e) => (genre = e.currentTarget.value || null)}
							class="h-10 rounded-full border border-border bg-background px-4 transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
						>
							<option value="">Any</option>
							{#each genres as g (g)}
								<option value={g}>{g}</option>
							{/each}
						</select>
					</label>
				</Popover.Content>
			</Popover.Root>
		</div>

		<!-- Poster grid -->
		{#if list.length > 0}
			<div class="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 lg:grid-cols-5">
				{#each list as item (item.mediaId)}
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
				{/each}
			</div>
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
