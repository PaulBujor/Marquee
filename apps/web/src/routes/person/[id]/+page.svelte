<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import ErrorState from '#lib/components/error-state.svelte';
	import OfflineState from '#lib/components/offline-state.svelte';
	import PageHeader from '#lib/components/page-header.svelte';
	import BackButton from '#lib/components/back-button.svelte';
	import ExpandableText from '#lib/components/expandable-text.svelte';
	import PersonAvatar from '#lib/components/media/person-avatar.svelte';
	import PosterTile from '#lib/components/media/poster-tile.svelte';
	import { posterUrl } from '#lib/media.js';
	import type { PersonCredit, PersonCreditsPage } from '#lib/server/tmdb/index.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// untrack: a deliberate one-shot read, like the search page; the effect below re-seeds on navigation.
	const initial = untrack(() => data.initial);
	let person = $state(initial?.person ?? null);
	let upcoming = $state<PersonCredit[]>(initial?.upcoming ?? []);
	let credits = $state<PersonCredit[]>(initial?.credits ?? []);
	let page = $state(initial?.page ?? 1);
	let totalPages = $state(initial?.totalPages ?? 1);
	let loadingMore = $state(false);
	let errored = $state(false);

	// A slow response for a person already navigated away from must not append to the current one.
	let seq = 0;

	$effect(() => {
		person = data.initial?.person ?? null;
		upcoming = data.initial?.upcoming ?? [];
		credits = data.initial?.credits ?? [];
		page = data.initial?.page ?? 1;
		totalPages = data.initial?.totalPages ?? 1;
		loadingMore = false;
		errored = false;
		seq++;
	});

	async function loadMore() {
		const mine = ++seq;
		const wanted = page + 1;
		loadingMore = true;
		errored = false;
		try {
			const res = await fetch(`/api/person/${data.id}?page=${wanted}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const next = (await res.json()) as PersonCreditsPage;
			if (mine !== seq) return;
			credits = [...credits, ...next.credits];
			page = next.page;
			totalPages = next.totalPages;
		} catch (err) {
			if (mine !== seq) return;
			errored = true;
			console.error(`person page: failed to load person ${data.id} page ${wanted}`, err);
		} finally {
			if (mine === seq) loadingMore = false;
		}
	}

	// Rebuilt per page: a live observer only reports intersection *changes*, so an in-range sentinel must re-fire.
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

	function creditMeta(credit: PersonCredit): string {
		return [credit.year, credit.role].filter((part) => Boolean(part)).join(' · ');
	}
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
					<!-- Fixed two-line box + single meta line so captions line up across a row whether a title wraps. -->
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

<main class="mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 pt-3 pb-tab-bar">
	{#if !data.reachable}
		<OfflineState message="Cast and crew details need a connection." />
	{:else if person}
		{#if person.placeOfBirth}
			<p class="text-sm text-muted-foreground">{person.placeOfBirth}</p>
		{/if}

		{#if person.biography}
			{#key person.tmdbId}
				<ExpandableText text={person.biography} class="text-sm leading-relaxed" />
			{/key}
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
		<!-- Load succeeded but sent nothing renderable: say so rather than pulsing a skeleton forever. -->
		<ErrorState message="Couldn't load this person." class="py-6" />
	{/if}
</main>
