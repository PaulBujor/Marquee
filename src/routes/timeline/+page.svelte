<script lang="ts">
	import { resolve } from '$app/paths';
	import { buttonVariants } from '$lib/components/ui/button';
	import PageHeader from '$lib/components/page-header.svelte';
	import DetailLink from '$lib/components/media/detail-link.svelte';
	import PosterTile from '$lib/components/media/poster-tile.svelte';
	import { LibraryState } from '$lib/tracking/library.svelte';
	import { filterUpcoming, groupUpcomingByYear } from '$lib/tracking/library';
	import { sync } from '$lib/client/sync/engine.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Reads local IndexedDB (works offline); reloads whenever a sync pulls — same pattern as home.
	const library = new LibraryState();
	$effect(() => {
		void sync.revision;
		library.load();
	});

	const upcoming = $derived(filterUpcoming(library.items));
	// Group into years, each holding per-day runs. The agenda only shows day + month, so a sticky
	// year divider tells you which year a release lands in.
	const years = $derived(groupUpcomingByYear(upcoming));

	// Format `YYYY-MM-DD` as e.g. "Tue, Jul 28" in UTC, so a local timezone can't shift the day.
	const dateFmt = new Intl.DateTimeFormat(undefined, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC'
	});
	function formatDate(iso: string): string {
		return dateFmt.format(new Date(`${iso}T00:00:00Z`));
	}
</script>

<svelte:head><title>Upcoming · Marquee</title></svelte:head>

<!-- No back control: this is a tab root. `min-h-10` keeps the header the height the sticky year
divider below is positioned against. -->
<PageHeader>
	<div class="flex min-h-10 items-center gap-3">
		<h1 class="font-serif text-xl font-semibold">Upcoming</h1>
	</div>
</PageHeader>

<main class="mx-auto flex w-full max-w-2xl flex-col gap-6 px-5 pt-3 pb-tab-bar">
	{#if !data.user}
		<div class="flex flex-col items-start gap-4 py-16">
			<p class="text-muted-foreground">Sign in to see your upcoming releases.</p>
			<a href={resolve('/login')} class={buttonVariants()}>Sign in</a>
		</div>
	{:else if years.length > 0}
		{#each years as { year, days } (year)}
			<div class="flex flex-col gap-6">
				<!-- Sticky, centered year divider — stays in view while its releases scroll past, so the
				day+month rows below always have a year for context. Sits just under the page header. -->
				<div class="sticky top-[4.25rem] z-10 -mb-2 flex justify-center">
					<span
						class="rounded-full border bg-background/80 px-3 py-0.5 text-xs font-bold tracking-widest text-muted-foreground uppercase backdrop-blur"
					>
						{year}
					</span>
				</div>
				{#each days as [date, entries] (date)}
					<section class="flex flex-col gap-2">
						<h2 class="text-xs font-bold tracking-widest text-muted-foreground uppercase">
							{formatDate(date)}
						</h2>
						<ul class="flex flex-col gap-1">
							{#each entries as entry (entry.mediaId + (entry.kind === 'episode' ? `-${entry.season}-${entry.episode}` : ''))}
								<li>
									<DetailLink
										item={entry}
										class="-mx-2 flex items-center gap-3 rounded-sm px-2 py-1.5 transition-colors hover:bg-secondary"
									>
										<div class="w-12 shrink-0">
											<PosterTile
												type={entry.type}
												mediaId={entry.mediaId}
												posterPath={entry.posterPath}
												isCustom={entry.source === 'custom'}
												alt={entry.title}
											/>
										</div>
										<div class="flex min-w-0 flex-1 flex-col gap-1">
											<span class="truncate font-medium">{entry.title}</span>
											<span class="text-sm text-muted-foreground">
												{entry.kind === 'episode'
													? `S${entry.season} · E${entry.episode}`
													: 'Release'}
											</span>
										</div>
									</DetailLink>
								</li>
							{/each}
						</ul>
					</section>
				{/each}
			</div>
		{/each}
	{:else}
		<p class="py-16 text-center text-sm text-muted-foreground">
			{library.ready ? 'Nothing upcoming.' : 'Loading…'}
		</p>
	{/if}
</main>
