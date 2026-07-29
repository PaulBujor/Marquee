<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { flip } from 'svelte/animate';
	import { fade, slide } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import { SvelteSet } from 'svelte/reactivity';
	import { buttonVariants } from '$lib/components/ui/button';
	import PosterTile from '$lib/components/media/poster-tile.svelte';
	import ProgressRing from '$lib/components/media/progress-ring.svelte';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as Popover from '$lib/components/ui/popover';
	import * as NativeSelect from '$lib/components/ui/native-select';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import SlidersIcon from '@lucide/svelte/icons/sliders-horizontal';
	import { library } from '$lib/tracking/library.svelte';
	import { sync } from '$lib/client/sync/engine.svelte';
	import {
		availableGenres,
		availableYears,
		continueWatching,
		filterAndSortLibrary,
		showProgress,
		type LibraryItem,
		type LibrarySort,
		type LibraryTab,
		type ReleaseFilter
	} from '$lib/tracking/library';
	import { canRate } from '$lib/tracking/actions';
	import CheckIcon from '@lucide/svelte/icons/check';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// The home library reads local IndexedDB (works offline); reloads whenever a sync pulls. It's a
	// module singleton, so navigating back from a detail page finds it already populated (MRQ-147).
	$effect(() => {
		void sync.revision;
		library.load();
	});

	// Suppress the poster intro transition on the first render after (re)mount — otherwise returning
	// to the dashboard fades the whole grid up from transparent, reading as a blank flash even though
	// the data is already there (MRQ-147). Real add/remove/status changes still animate.
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
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

	const SORTS: LibrarySort[] = ['added', 'title', 'date'];
	const SORT_LABELS: Record<LibrarySort, string> = {
		added: 'Date added',
		title: 'Title',
		date: 'Release date'
	};

	const RELEASES: ReleaseFilter[] = ['all', 'released', 'upcoming'];
	const RELEASE_LABELS: Record<ReleaseFilter, string> = {
		all: 'All',
		released: 'Released',
		upcoming: 'Upcoming'
	};

	// Selected tab + filters live in the URL (like the search page), so a view is shareable and
	// survives reload / back-forward. Defaults are omitted from the query to keep it clean.
	function readState() {
		const p = page.url.searchParams;
		const t = p.get('tab');
		const ty = p.get('type');
		const s = p.get('sort');
		const y = p.get('year');
		const r = p.get('release');
		return {
			tab: (TABS.some((x) => x.key === t) ? t : 'want_to_watch') as LibraryTab,
			typeFilter: (TYPES.some((x) => x.key === ty) ? ty : 'all') as TypeFilter,
			sort: (SORTS.includes(s as LibrarySort) ? s : 'date') as LibrarySort,
			year: y && Number.isFinite(Number(y)) ? Number(y) : null,
			genre: p.get('genre') || null,
			release: (RELEASES.includes(r as ReleaseFilter) ? r : 'released') as ReleaseFilter
		};
	}

	const initial = untrack(() => readState());
	let tab = $state<LibraryTab>(initial.tab);
	let typeFilter = $state<TypeFilter>(initial.typeFilter);
	let year = $state<number | null>(initial.year);
	let genre = $state<string | null>(initial.genre);
	let sort = $state<LibrarySort>(initial.sort);
	let release = $state<ReleaseFilter>(initial.release);

	// Mirror state → URL. Skips when already in sync (so seeding / back-forward don't loop). Built
	// as a plain string (tab/type/sort are enum-safe; genre is encoded) — no URLSearchParams.
	$effect(() => {
		const parts: string[] = [];
		if (tab !== 'want_to_watch') parts.push(`tab=${tab}`);
		if (typeFilter !== 'all') parts.push(`type=${typeFilter}`);
		if (sort !== 'date') parts.push(`sort=${sort}`);
		if (year !== null) parts.push(`year=${year}`);
		if (genre !== null) parts.push(`genre=${encodeURIComponent(genre)}`);
		if (release !== 'released') parts.push(`release=${release}`);
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
			release = s.release;
		}
	});

	const inProgress = $derived(continueWatching(library.items));
	const years = $derived(availableYears(library.items));
	const genres = $derived(availableGenres(library.items));
	const list = $derived(
		filterAndSortLibrary(library.items, { tab, type: typeFilter, year, genre, release, sort })
	);
	// Type is surfaced as its own always-visible control; the popover badges when a year/genre
	// narrowing is active (sort is a preference, not a narrowing, so it doesn't count).
	const advancedActive = $derived(year !== null || genre !== null || release !== 'released');

	const filtersActive = $derived(
		typeFilter !== 'all' ||
			year !== null ||
			genre !== null ||
			release !== 'released' ||
			sort !== 'date'
	);
	function clearFilters() {
		typeFilter = 'all';
		year = null;
		genre = null;
		release = 'released';
		sort = 'date';
	}

	// Infinite scroll: PAGE_SIZE at a time; reset to the top on view change, keep position on sync grow.
	const PAGE_SIZE = 30;
	let visibleCount = $state(PAGE_SIZE);
	const visible = $derived(list.slice(0, visibleCount));
	const hasMore = $derived(visibleCount < list.length);

	// Reset to the first page only on a *genuine* view change — not on the initial mount or the
	// back/forward re-seed. The guard (skip when the key is unchanged) lets a restored snapshot's
	// visibleCount survive a remount; the popstate re-seed writes the same filter values back, and
	// Svelte skips equal assignments, so it never trips this.
	const viewKey = $derived(`${tab}|${typeFilter}|${year}|${genre}|${release}|${sort}`);
	let lastViewKey = untrack(() => viewKey);
	$effect(() => {
		if (viewKey !== lastViewKey) {
			lastViewKey = viewKey;
			visibleCount = PAGE_SIZE;
		}
	});

	// Preserve pagination depth + scroll across navigation. Opening a title unmounts this route, so
	// without a snapshot Back would reinitialize visibleCount to PAGE_SIZE and lose scroll (MRQ-156).
	// The `library` singleton is already populated on Back, so restoring visibleCount renders the full
	// grid synchronously; we scroll after a tick so the page is tall enough to reach the saved offset.
	export const snapshot = {
		capture: () => ({ visibleCount, scrollY: window.scrollY }),
		restore: (v: { visibleCount: number; scrollY: number }) => {
			visibleCount = v.visibleCount;
			void tick().then(() => window.scrollTo(0, v.scrollY));
		}
	};

	let loadMoreSentinel = $state<HTMLElement | null>(null);
	$effect(() => {
		const el = loadMoreSentinel;
		if (!el || typeof IntersectionObserver === 'undefined') return;
		const io = new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting && visibleCount < list.length) {
					visibleCount = Math.min(visibleCount + PAGE_SIZE, list.length);
				}
			},
			{ rootMargin: '600px' }
		);
		io.observe(el);
		return () => io.disconnect();
	});

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

	// Honour the OS "reduce motion" setting: durations collapse to 0 (instant, no jank) when set.
	// This is the app's first reduced-motion guard, so it also covers the pre-existing card motion.
	const reduced = $derived(prefersReducedMotion.current);
	const motionMs = $derived(reduced ? 0 : 300);
	// Intro (enter) duration: 0 until mounted so the grid doesn't fade up on a back-nav remount, then
	// the normal duration so real adds/removals animate. Outros always use `motionMs`.
	const introMs = $derived(mounted ? motionMs : 0);
</script>

<svelte:head><title>Marquee</title></svelte:head>

{#if data.user}
	<main class="mx-auto w-full max-w-3xl px-5 pt-2 pb-16">
		<!-- Continue watching — in-progress shows only (movies have no next episode) -->
		{#if inProgress.length > 0}
			<!-- Slide the whole section (heading + row) so the rest of the page eases up when the last
			in-progress show is marked, instead of the block popping out. -->
			<section class="mb-6" transition:slide={{ duration: introMs }}>
				<h2 class="mb-2.5 text-xs font-bold tracking-widest text-muted-foreground uppercase">
					Continue Watching
				</h2>
				<div class="no-scrollbar flex gap-3 overflow-x-auto pb-1">
					{#each inProgress as item (item.mediaId)}
						{@const progress = showProgress(item)}
						<div
							class="w-28 shrink-0"
							animate:flip={{ duration: reduced ? 0 : 320 }}
							transition:fade={{ duration: introMs }}
						>
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
					<div class="flex flex-col gap-1 text-sm">
						<span class="text-xs font-medium text-muted-foreground">Sort</span>
						<NativeSelect.Root
							class="w-full"
							value={sort}
							onchange={(e) => (sort = e.currentTarget.value as LibrarySort)}
						>
							{#each SORTS as s (s)}
								<NativeSelect.Option value={s}>{SORT_LABELS[s]}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					</div>
					<div class="flex flex-col gap-1 text-sm">
						<span class="text-xs font-medium text-muted-foreground">Release</span>
						<NativeSelect.Root
							class="w-full"
							value={release}
							onchange={(e) => (release = e.currentTarget.value as ReleaseFilter)}
						>
							{#each RELEASES as r (r)}
								<NativeSelect.Option value={r}>{RELEASE_LABELS[r]}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					</div>
					<div class="flex flex-col gap-1 text-sm">
						<span class="text-xs font-medium text-muted-foreground">Year</span>
						<NativeSelect.Root
							class="w-full"
							value={year === null ? '' : String(year)}
							onchange={(e) =>
								(year = e.currentTarget.value ? Number(e.currentTarget.value) : null)}
						>
							<NativeSelect.Option value="">Any</NativeSelect.Option>
							{#each years as y (y)}
								<NativeSelect.Option value={String(y)}>{y}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					</div>
					<div class="flex flex-col gap-1 text-sm">
						<span class="text-xs font-medium text-muted-foreground">Genre</span>
						<NativeSelect.Root
							class="w-full"
							value={genre ?? ''}
							onchange={(e) => (genre = e.currentTarget.value || null)}
						>
							<NativeSelect.Option value="">Any</NativeSelect.Option>
							{#each genres as g (g)}
								<NativeSelect.Option value={g}>{g}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					</div>
					<button
						type="button"
						onclick={clearFilters}
						disabled={!filtersActive}
						class="{buttonVariants({ variant: 'ghost', size: 'sm' })} w-full"
					>
						Clear filters
					</button>
				</Popover.Content>
			</Popover.Root>
		</div>

		<!-- Poster grid -->
		{#if list.length > 0}
			<div class="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 lg:grid-cols-5">
				<!-- flip reflows survivors; fade eases items in/out on sync add/remove or status change -->
				{#each visible as item (item.mediaId)}
					<a
						href={resolve('/title/[type]/[id]', {
							type: item.type,
							id: item.externalId?.split('/')[1] ?? ''
						})}
						class="block"
						animate:flip={{ duration: motionMs }}
						transition:fade={{ duration: introMs }}
					>
						<PosterTile
							type={item.type}
							mediaId={item.mediaId}
							posterPath={item.posterPath}
							isFavorite={item.favorite}
							rating={canRate(item.type, item.status) ? item.rating : null}
							alt={item.title}
						/>
						<div class="mt-1.5 truncate text-sm font-medium">{item.title}</div>
						{#if item.year}<div class="text-xs text-muted-foreground">{item.year}</div>{/if}
					</a>
				{/each}
			</div>
			{#if hasMore}
				<div
					bind:this={loadMoreSentinel}
					class="py-6 text-center text-sm text-muted-foreground"
					aria-hidden="true"
				>
					Loading more…
				</div>
			{/if}
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
