<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import ErrorState from '$lib/components/error-state.svelte';
	import PersonAvatar from './person-avatar.svelte';
	import PosterTile from './poster-tile.svelte';
	import { posterUrl } from '$lib/media.js';
	import type { PersonCredit, PersonCreditsPage, PersonDetail } from '$lib/server/tmdb';

	/**
	 * A cast or crew member's biography and filmography, over the title page. Network-only: people
	 * aren't part of the offline replica, so this shows an error state rather than a cached copy when
	 * it can't reach the API. Open/closed is driven by the parent's shallow-routing state, which is
	 * what makes Back close the modal.
	 */
	interface Props {
		/** TMDB person id to show, or null when the modal is closed. */
		personId: number | null;
		/**
		 * Where a credit links. The parent builds it so a title opened from here joins the same
		 * suggestion chain as one opened from the "Similar" row.
		 */
		href: (type: 'movie' | 'show', id: number) => string;
		onclose: () => void;
	}
	let { personId, href, onclose }: Props = $props();

	let person = $state<PersonDetail | null>(null);
	let upcoming = $state<PersonCredit[]>([]);
	let credits = $state<PersonCredit[]>([]);
	let page = $state(1);
	let totalPages = $state(1);
	let loading = $state(false);
	let loadingMore = $state(false);
	let errored = $state(false);
	let bioOpen = $state(false);

	// Bumped on every new load so a slow response for a person the user has already navigated away
	// from can't overwrite the current one — the same guard the season switcher and MediaImage use.
	let seq = 0;

	$effect(() => {
		const id = personId;
		if (id === null) {
			// Nothing to show; also cancels whatever was in flight.
			seq++;
			return;
		}
		person = null;
		upcoming = [];
		credits = [];
		page = 1;
		totalPages = 1;
		errored = false;
		bioOpen = false;
		// Drop the previous person's measured height so the skeleton doesn't render one frame at
		// their size before `measure()` catches up.
		bodyHeight = null;
		void load(id, 1);
	});

	async function load(id: number, next: number) {
		const mine = ++seq;
		if (next === 1) loading = true;
		else loadingMore = true;
		errored = false;

		try {
			const res = await fetch(`/api/person/${id}?page=${next}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as PersonCreditsPage;
			if (mine !== seq) return;

			person = data.person;
			upcoming = data.upcoming;
			credits = next === 1 ? data.credits : [...credits, ...data.credits];
			page = data.page;
			totalPages = data.totalPages;
		} catch (err) {
			if (mine !== seq) return;
			errored = true;
			console.error(`person modal: failed to load person ${id} page ${next}`, err);
		} finally {
			if (mine === seq) {
				loading = false;
				loadingMore = false;
			}
		}
	}

	/** Re-run the first page after it failed. */
	function reload() {
		if (personId !== null) void load(personId, 1);
	}

	/** Append the next page of released credits (also the retry for a failed append). */
	function loadMore() {
		if (personId !== null) void load(personId, page + 1);
	}

	// Pull the next page as the end of the list comes into view, the same sentinel + observer the
	// dashboard grid uses. The root is the dialog's own scroller rather than the viewport, and the
	// observer is rebuilt per page so a sentinel still in range after an append fires again — a
	// live observer only reports intersection *changes*.
	let sentinel = $state<HTMLElement | null>(null);
	$effect(() => {
		const el = sentinel;
		const root = scroller;
		void page;
		if (!el || !root || typeof IntersectionObserver === 'undefined') return;
		const io = new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting && !loadingMore && !errored) loadMore();
			},
			{ root, rootMargin: '400px' }
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

	// The body grows a long way when the skeleton is replaced by a real filmography. Left alone the
	// dialog snaps to its new size; instead the measured content height is written back and CSS
	// transitions it. Measured rather than transitioning `height: auto` because that only animates
	// where `interpolate-size` is supported, which excludes Safari — and this ships as an iOS PWA.
	let scroller = $state<HTMLDivElement | null>(null);
	let content = $state<HTMLDivElement | null>(null);
	let bodyHeight = $state<number | null>(null);

	$effect(() => {
		const outer = scroller;
		const inner = content;
		if (!outer || !inner) return;

		const measure = () => {
			// The cap lives in CSS (see the scroller's `max-h`); clamp here too, or the transition
			// would run against a height the element can never reach and appear to finish instantly.
			const cap = Number.parseFloat(getComputedStyle(outer).maxHeight);
			const natural = inner.getBoundingClientRect().height;
			bodyHeight = Number.isFinite(cap) ? Math.min(natural, cap) : natural;
		};

		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(inner);
		return () => observer.disconnect();
	});
</script>

{#snippet creditGrid(items: PersonCredit[])}
	<ul class="grid grid-cols-3 gap-3 sm:grid-cols-4">
		{#each items as credit (`${credit.type}:${credit.tmdbId}`)}
			<li>
				<!-- The parent builds this href from resolve() + the chain query string, which drops
				resolve()'s branded type — same as the "Similar" row on the title page. -->
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
				<a href={href(credit.type, credit.tmdbId)} class="block">
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

<Dialog.Root
	open={personId !== null}
	onOpenChange={(open) => {
		if (!open) onclose();
	}}
>
	<Dialog.Content
		class="flex max-h-[85svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
		aria-busy={loading}
	>
		<Dialog.Header class="flex-row items-center gap-3 border-b border-border p-4 pr-12">
			{#if person}
				<PersonAvatar
					name={person.name}
					profilePath={person.profilePath}
					class="size-16 shrink-0"
				/>
				<div class="flex min-w-0 flex-col gap-1">
					<Dialog.Title class="truncate text-lg">{person.name}</Dialog.Title>
					<Dialog.Description class="text-xs">
						{subtitle || 'No biographical details.'}
						{#if person.placeOfBirth}
							<span class="block truncate">{person.placeOfBirth}</span>
						{/if}
					</Dialog.Description>
				</div>
			{:else}
				<!-- Kept in the accessibility tree while the real name loads, so the dialog is always named. -->
				<Dialog.Title class="sr-only">Person details</Dialog.Title>
				<Dialog.Description class="sr-only">
					{errored ? 'This person could not be loaded.' : 'Loading person details.'}
				</Dialog.Description>
				<Skeleton class="size-16 shrink-0 rounded-full" />
				<!-- Mirrors the loaded header's name + subtitle + birthplace, so it doesn't reflow. -->
				<div class="flex min-w-0 flex-1 flex-col gap-2">
					<Skeleton class="h-5 w-40 max-w-full" />
					<Skeleton class="h-3 w-24 max-w-full" />
					<Skeleton class="h-3 w-32 max-w-full" />
				</div>
			{/if}
		</Dialog.Header>

		<!-- The cap is the dialog's 85svh less the header, which is a fixed 6rem (a 4rem avatar plus
		its padding and border). `measure()` reads it back off this element, so the two stay in step. -->
		<div
			bind:this={scroller}
			class="max-h-[calc(85svh-6rem)] overflow-y-auto transition-[height] duration-200 ease-out motion-reduce:transition-none"
			style:height={bodyHeight === null ? undefined : `${bodyHeight}px`}
		>
			<div bind:this={content} class="flex flex-col gap-5 p-4">
				{#if errored && !person}
					<ErrorState message="Couldn't load this person." retry={reload} class="py-6" />
				{:else if loading}
					<div class="flex flex-col gap-2">
						<Skeleton class="h-3 w-full" />
						<Skeleton class="h-3 w-full" />
						<Skeleton class="h-3 w-2/3" />
					</div>
					<!-- Two full rows, so the height the dialog animates from is close to the loaded one. -->
					<ul class="grid grid-cols-3 gap-3 sm:grid-cols-4">
						{#each [0, 1, 2, 3, 4, 5, 6, 7] as i (i)}
							<li class="flex flex-col gap-1.5">
								<Skeleton class="aspect-[2/3] w-full rounded-md" />
								<Skeleton class="h-3 w-full" />
								<Skeleton class="h-2.5 w-2/3" />
							</li>
						{/each}
					</ul>
				{:else if person}
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
				{/if}
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
