<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import PageHeader from '$lib/components/page-header.svelte';
	import PosterTile from '$lib/components/media/poster-tile.svelte';
	import { LibraryState } from '$lib/tracking/library.svelte';
	import { filterUpcoming, type UpcomingEntry } from '$lib/tracking/library';
	import { sync } from '$lib/client/sync/engine.svelte';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Reads local IndexedDB (works offline); reloads whenever a sync pulls — same pattern as home.
	const library = new LibraryState();
	$effect(() => {
		void sync.revision;
		library.load();
	});

	const upcoming = $derived(filterUpcoming(library.items));
	// Group into [date, entries] runs. `upcoming` is already date-sorted, so equal dates are
	// adjacent — a single linear pass over plain arrays (no Map) preserves order.
	const groups = $derived.by(() => {
		const out: [string, UpcomingEntry[]][] = [];
		for (const e of upcoming) {
			const last = out[out.length - 1];
			if (last && last[0] === e.date) last[1].push(e);
			else out.push([e.date, [e]]);
		}
		return out;
	});

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

<PageHeader>
	<div class="flex items-center gap-3">
		<Button
			href={resolve('/')}
			variant="outline"
			size="icon"
			shape="round"
			class="shrink-0 text-muted-foreground"
			aria-label="Back to home"
		>
			<ChevronLeftIcon class="size-4" />
		</Button>
		<h1 class="text-lg font-semibold">Upcoming</h1>
	</div>
</PageHeader>

<main class="mx-auto flex w-full max-w-2xl flex-col gap-6 px-5 pt-3 pb-16">
	{#if !data.user}
		<div class="flex flex-col items-start gap-4 py-16">
			<p class="text-muted-foreground">Sign in to see your upcoming releases.</p>
			<a href={resolve('/login')} class={buttonVariants()}>Sign in</a>
		</div>
	{:else if groups.length > 0}
		{#each groups as [date, entries] (date)}
			<section class="flex flex-col gap-2">
				<h2 class="text-xs font-bold tracking-widest text-muted-foreground uppercase">
					{formatDate(date)}
				</h2>
				<ul class="flex flex-col gap-1">
					{#each entries as entry (entry.mediaId + (entry.kind === 'episode' ? `-${entry.season}-${entry.episode}` : ''))}
						<li>
							<a
								href={resolve('/title/[type]/[id]', {
									type: entry.type,
									id: entry.externalId?.split('/')[1] ?? ''
								})}
								class="-mx-2 flex items-center gap-3 rounded-[10px] px-2 py-1.5 transition-colors hover:bg-secondary"
							>
								<div class="w-12 shrink-0">
									<PosterTile
										type={entry.type}
										mediaId={entry.mediaId}
										posterPath={entry.posterPath}
										alt={entry.title}
									/>
								</div>
								<div class="flex min-w-0 flex-1 flex-col gap-1">
									<span class="truncate font-medium">{entry.title}</span>
									<span class="text-sm text-muted-foreground">
										{entry.kind === 'episode' ? `S${entry.season} · E${entry.episode}` : 'Release'}
									</span>
								</div>
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	{:else}
		<p class="py-16 text-center text-sm text-muted-foreground">
			{library.ready ? 'Nothing upcoming.' : 'Loading…'}
		</p>
	{/if}
</main>
