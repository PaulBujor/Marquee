<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import ErrorState from '$lib/components/error-state.svelte';
	import OfflineState from '$lib/components/offline-state.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import BackButton from '$lib/components/back-button.svelte';
	import PersonAvatar from '$lib/components/media/person-avatar.svelte';
	import PosterTile from '$lib/components/media/poster-tile.svelte';
	import { posterUrl } from '$lib/media.js';
	import type { PersonCredit } from '$lib/server/tmdb';
	import type { PageData } from './$types';

	/**
	 * A person's biography and filmography. Network-only — people aren't part of the offline replica,
	 * so there is no cached copy to fall back to and the page says so rather than sitting empty.
	 */
	let { data }: { data: PageData } = $props();

	// Seeded once from the load (untrack marks the initial read as intentional, as the search page
	// does); the effect below re-seeds on a navigation to another person.
	const initial = untrack(() => data.initial);
	let person = $state(initial?.person ?? null);
	let upcoming = $state<PersonCredit[]>(initial?.upcoming ?? []);
	let credits = $state<PersonCredit[]>(initial?.credits ?? []);
	let page = $state(initial?.page ?? 1);
	let totalPages = $state(initial?.totalPages ?? 1);
	let loadingMore = $state(false);
	let errored = $state(false);
	let bioOpen = $state(false);

	// Re-seed when the route changes to another person — this component is reused across those
	// navigations, so leaving the previous filmography on screen would be wrong.
	$effect(() => {
		person = data.initial?.person ?? null;
		upcoming = data.initial?.upcoming ?? [];
		credits = data.initial?.credits ?? [];
		page = data.initial?.page ?? 1;
		totalPages = data.initial?.totalPages ?? 1;
		loadingMore = false;
		errored = false;
		bioOpen = false;
		seq++;
	});

	// Bumped on every load so a slow response for a person the user has already navigated away from
	// can't append to the current one — the same guard the season switcher and MediaImage use.
	let seq = 0;

	/** Append the next page of released credits (also the retry for a failed append). */
	async function loadMore() {
		const mine = ++seq;
		loadingMore = true;
		errored = false;
		try {
			const res = await fetch(`/api/person/${data.id}?page=${page + 1}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const next = (await res.json()) as typeof data.initial;
			if (mine !== seq || !next) return;
			credits = [...credits, ...next.credits];
			page = next.page;
			totalPages = next.totalPages;
		} catch (err) {
			if (mine !== seq) return;
			errored = true;
			console.error(`person page: failed to load person ${data.id} page ${page + 1}`, err);
		} finally {
			if (mine === seq) loadingMore = false;
		}
	}

	// Pull the next page as the end of the list comes into view — the same sentinel + observer the
	// dashboard grid uses, against the viewport now that this is a page rather than a dialog. Rebuilt
	// per page so a sentinel still in range after an append fires again: a live observer only reports
	// intersection *changes*.
	let sentinel = $state<HTMLElement | null>(null);
	$effect(() => {
		const el = sentinel;
		void page;
		if (!el || typeof IntersectionObserver === 'undefined') return;
		const io = new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting && !loadingMore && !errored) void loadMore();
			},
			{ rootMargin: '400px' }
		);
		io.observe(el);
		return () => io.disconnect();
	});

	// "Directing · 1970–2001" / "Acting · b. 1963" — whichever parts TMDB actually has.
	const lifespan = $derived.by(() => {
		const born = person?.birthday?.slice(0, 4);
		const died = person?.deathday?.slice(0, 4);
		if (born && died) return `${born}–${died}`;
		if (born) return `b. ${born}`;
		if (died) return `d. ${died}`;
		return null;
	});
	const subtitle = $derived(
		[person?.knownForDepartment, lifespan].filter((part) => Boolean(part)).join(' · ')
	);

	/** A credit's one-line caption under the title — "2010 · Cobb". */
	function creditMeta(credit: PersonCredit): string {
		return [credit.year, credit.role].filter((part) => Boolean(part)).join(' · ');
	}

	// Only offer the bio toggle when the text is actually cut off — a short biography fits inside the
	// clamp, and a "Read more" that reveals nothing is worse than no control at all. Measured while
	// collapsed; expanding removes the clamp, so skip re-measuring then or the control would vanish
	// the moment it was used.
	let bio = $state<HTMLParagraphElement | null>(null);
	let bioClamped = $state(false);
	$effect(() => {
		const el = bio;
		if (!el || bioOpen) return;
		bioClamped = el.scrollHeight > el.clientHeight + 1;
	});
</script>

<svelte:head><title>{person ? `${person.name} · Marquee` : 'Marquee'}</title></svelte:head>

{#snippet creditGrid(items: PersonCredit[])}
	<ul class="grid grid-cols-3 gap-3 sm:grid-cols-4">
		{#each items as credit (`${credit.type}:${credit.tmdbId}`)}
			<li>
				<a
					href={resolve('/title/[type]/[id]', {
						type: credit.type,
						id: String(credit.tmdbId)
					})}
					class="block"
				>
					<PosterTile
						type={credit.type}
						posterUrl={posterUrl(credit.posterPath)}
						alt={credit.title}
					/>
					<!-- Fixed two-line title box and a single meta line, so the captions across a row line
					up whether or not a title wraps. -->
					<p class="mt-1.5 line-clamp-2 h-[2.5em] text-[0.7rem] leading-tight font-medium">
						{credit.title}
					</p>
					<p class="line-clamp-1 h-[1.25em] text-[0.65rem] leading-tight text-muted-foreground">
						{creditMeta(credit)}
					</p>
				</a>
			</li>
		{/each}
	</ul>
{/snippet}

{#snippet sectionHeading(text: string)}
	<h2 class="text-xs font-bold tracking-widest text-muted-foreground uppercase">{text}</h2>
{/snippet}

<PageHeader>
	<div class="flex min-h-10 items-center gap-3">
		<BackButton label="Back" />
		{#if person}
			<PersonAvatar name={person.name} profilePath={person.profilePath} class="size-10 shrink-0" />
			<div class="flex min-w-0 flex-col">
				<h1 class="truncate font-serif text-xl font-semibold">{person.name}</h1>
				{#if subtitle}
					<p class="truncate text-xs text-muted-foreground">{subtitle}</p>
				{/if}
			</div>
		{:else}
			<h1 class="font-serif text-xl font-semibold">Person</h1>
		{/if}
	</div>
</PageHeader>

<main class="mx-auto flex w-full max-w-2xl flex-col gap-5 px-5 pt-3 pb-tab-bar">
	{#if !data.reachable}
		<OfflineState message="Cast and crew details need a connection." />
	{:else if person}
		{#if person.placeOfBirth}
			<p class="text-sm text-muted-foreground">{person.placeOfBirth}</p>
		{/if}

		{#if person.biography}
			<div class="flex flex-col items-start gap-1">
				<p bind:this={bio} class="text-sm leading-relaxed {bioOpen ? '' : 'line-clamp-5'}">
					{person.biography}
				</p>
				{#if bioClamped}
					<button
						type="button"
						onclick={() => (bioOpen = !bioOpen)}
						aria-expanded={bioOpen}
						class="text-xs font-semibold text-primary hover:underline"
					>
						{bioOpen ? 'Show less' : 'Read more'}
					</button>
				{/if}
			</div>
		{/if}

		{#if upcoming.length > 0}
			<section class="flex flex-col gap-3">
				{@render sectionHeading('Upcoming')}
				{@render creditGrid(upcoming)}
			</section>
		{/if}

		{#if credits.length > 0}
			<section class="flex flex-col gap-3">
				{@render sectionHeading(upcoming.length > 0 ? 'Released' : 'Filmography')}
				{@render creditGrid(credits)}

				{#if errored}
					<ErrorState message="Couldn't load more credits." retry={loadMore} class="py-4" />
				{:else if page < totalPages}
					<div
						bind:this={sentinel}
						class="py-2 text-center text-sm text-muted-foreground"
						aria-hidden="true"
					>
						Loading more…
					</div>
				{/if}
			</section>
		{:else if upcoming.length === 0}
			<p class="py-6 text-center text-sm text-muted-foreground">
				No credits listed for this person.
			</p>
		{/if}
	{:else}
		<!-- Reached only on a hard reload where the load ran but returned nothing renderable. -->
		<div class="flex flex-col gap-2">
			<Skeleton class="h-3 w-full" />
			<Skeleton class="h-3 w-full" />
			<Skeleton class="h-3 w-2/3" />
		</div>
	{/if}
</main>
