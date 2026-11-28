<script lang="ts">
	/**
	 * Time travel: the dial sets a moment, the panel shows the library as it was then, and every
	 * revert is a *new* event that brings the present back to that state (see `restore.ts`).
	 */
	import PageHeader from '#lib/components/page-header.svelte';
	import BackButton from '#lib/components/back-button.svelte';
	import PosterTile from '#lib/components/media/poster-tile.svelte';
	import TimeDial from '#lib/components/history/time-dial.svelte';
	import { Button, buttonVariants } from '#lib/components/ui/button/index.js';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { getAllEvents, getAllMedia, type ClientMedia } from '#lib/client/idb/index.js';
	import { restoreTitles } from '#lib/client/history/restore.js';
	import { sync } from '#lib/client/sync/engine.svelte.js';
	import { prefersReducedMotion } from 'svelte/motion';
	import {
		REWIND_STOPS,
		compensatingEventCount,
		diffStates,
		relativeAgo,
		stateAt,
		summarize,
		touchedSince,
		type TitleDiff
	} from '#lib/sync/history.js';
	import type { EventEnvelope, TrackingStatus } from '#lib/sync/events.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let events = $state<EventEnvelope[]>([]);
	let media = $state(new Map<string, ClientMedia>());
	/** Epoch ms "now" is measured from for this view of the log. */
	let anchor = $state(Date.now());
	let stopIndex = $state(0);
	let ready = $state(false);
	let busy = $state(false);
	let status = $state('');

	async function load() {
		const [log, records] = await Promise.all([getAllEvents(), getAllMedia()]);
		events = log;
		media = new Map(records.map((record) => [record.id, record]));
		anchor = Date.now();
		ready = true;
	}

	// Re-read on every sync that moved data, so another device's changes land in the log too.
	$effect(() => {
		if (!data.user) return;
		void sync.revision;
		void load();
	});

	const reduced = $derived(prefersReducedMotion.current);
	const stop = $derived(REWIND_STOPS[stopIndex]);
	const cutoff = $derived(anchor - stop.ms);
	const then = $derived(stateAt(events, cutoff));
	const now = $derived(stateAt(events, anchor));
	const diffs = $derived(diffStates(now, then));
	const counts = $derived(summarize(then));
	/** Titles the log touched in the window, newest first — the film strip's running order. */
	const strip = $derived(touchedSince(events, cutoff, anchor).slice(0, 20));
	const totalEvents = $derived(compensatingEventCount(diffs));

	const momentFormat = new Intl.DateTimeFormat(undefined, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
	const momentLabel = $derived(momentFormat.format(new Date(cutoff)));

	const STATUS_LABEL: Record<TrackingStatus, string> = {
		want_to_watch: 'On list',
		watching: 'Watching',
		completed: 'Watched',
		did_not_finish: "Didn't finish"
	};

	function record(mediaId: string): ClientMedia | undefined {
		return media.get(mediaId);
	}

	/** What the restore will change about one title, in the order the events are written. */
	function changes(diff: TitleDiff): string[] {
		const out: string[] = [];
		if (diff.remove) out.push('Off your lists');
		else if (diff.readd) {
			out.push(`Back on your lists · ${STATUS_LABEL[diff.status ?? 'want_to_watch']}`);
		} else if (diff.status) out.push(`Status → ${STATUS_LABEL[diff.status]}`);
		if (diff.favorite !== undefined) out.push(diff.favorite ? 'Favorite' : 'Not a favorite');
		if (diff.rating !== undefined) {
			out.push(diff.rating === null ? 'Rating cleared' : `Rating → ${diff.rating}`);
		}
		const count = (n: number) => `${n} episode${n === 1 ? '' : 's'}`;
		if (diff.episodes.watched.length) out.push(`+${count(diff.episodes.watched.length)} watched`);
		if (diff.episodes.unwatched.length) {
			out.push(`−${count(diff.episodes.unwatched.length)} watched`);
		}
		return out;
	}

	async function restore(list: TitleDiff[]) {
		if (list.length === 0 || busy) return;
		busy = true;
		try {
			const written = await restoreTitles(list);
			sync.requestSync();
			await load();
			status = `Rewound ${list.length} title${list.length === 1 ? '' : 's'} — ${written} event${written === 1 ? '' : 's'} written.`;
		} catch (err) {
			console.error('history: rewind failed', err);
			status = "Couldn't rewind that. Please try again.";
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Rewind · Marquee</title></svelte:head>

<PageHeader>
	<div class="flex min-h-10 items-center gap-3">
		<BackButton />
		<h1 class="font-serif text-xl font-semibold">Rewind</h1>
	</div>
</PageHeader>

<main class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 pt-3 pb-tab-bar">
	<section class="flex flex-col items-center gap-2 rounded-xl border bg-card p-4">
		<TimeDial index={stopIndex} onchange={(next) => (stopIndex = next)} />

		<p class="font-serif text-2xl font-semibold" aria-live="polite">
			{relativeAgo(stop.ms)}
		</p>
		<p class="text-xs text-muted-foreground">
			Drag the hand, scroll, or step with the arrow keys · Home returns to now
		</p>

		{#if strip.length > 0}
			<!-- aria-hidden: the panel below is the accessible list; this is the motion. -->
			<div class="-mx-4 w-full overflow-hidden" aria-hidden="true">
				<ul
					class="flex w-max gap-2 px-4 pt-2 will-change-transform"
					style:transform={`translate3d(${reduced ? 0 : -stopIndex * 24}px, 0, 0)`}
					style:transition={reduced ? 'none' : 'transform 520ms cubic-bezier(.22,1,.36,1)'}
				>
					{#each strip as mediaId, i (mediaId)}
						{@const item = record(mediaId)}
						<li
							class="w-14 shrink-0"
							style:opacity={Math.max(0.2, 1 - i * 0.12)}
							style:transform={`translate3d(0, ${reduced ? 0 : i * 1.5}px, 0)`}
							style:transition={reduced ? 'none' : `opacity 400ms ${i * 20}ms ease-out`}
						>
							<PosterTile
								type={item?.type ?? 'movie'}
								{mediaId}
								posterPath={item?.posterPath ?? null}
								isCustom={item?.source === 'custom'}
								alt={item?.title ?? ''}
							/>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</section>

	<section class="flex flex-col gap-3 rounded-xl border bg-card p-4">
		<header class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
			<h2 class="font-serif text-lg font-semibold">As of {relativeAgo(stop.ms)}</h2>
			<p class="text-xs text-muted-foreground">{momentLabel}</p>
		</header>

		<p class="text-sm text-muted-foreground">
			{counts.titles}
			{counts.titles === 1 ? 'title' : 'titles'} · {counts.episodes}
			{counts.episodes === 1 ? 'episode' : 'episodes'} watched
		</p>

		<p class="sr-only" role="status" aria-live="polite">{status}</p>
		{#if status}
			<p class="text-sm text-primary">{status}</p>
		{/if}

		{#if !ready}
			<p class="py-6 text-center text-sm text-muted-foreground">Loading your history…</p>
		{:else if diffs.length === 0}
			<p class="py-6 text-center text-sm text-muted-foreground">
				{stopIndex === 0
					? 'This is now — turn the dial back to see what changed.'
					: 'Nothing differs from now at this moment.'}
			</p>
		{:else}
			<ul class="flex flex-col divide-y">
				{#each diffs as diff (diff.mediaId)}
					{@const item = record(diff.mediaId)}
					<li class="flex items-start gap-3 py-2.5">
						<div class="w-10 shrink-0">
							<PosterTile
								type={item?.type ?? 'movie'}
								mediaId={diff.mediaId}
								posterPath={item?.posterPath ?? null}
								isCustom={item?.source === 'custom'}
								alt={item?.title ?? ''}
							/>
						</div>
						<div class="flex min-w-0 flex-1 flex-col gap-0.5">
							<span class="truncate text-sm font-medium">{item?.title ?? 'Unknown title'}</span>
							<span class="text-xs text-muted-foreground">{changes(diff).join(' · ')}</span>
						</div>
						<Button
							variant="outline"
							size="sm"
							disabled={busy}
							onclick={() => restore([diff])}
							aria-label={`Rewind ${item?.title ?? 'this title'}`}
						>
							Revert · {compensatingEventCount([diff])} event{compensatingEventCount([diff]) === 1
								? ''
								: 's'}
						</Button>
					</li>
				{/each}
			</ul>

			<div class="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
				<p class="text-xs text-muted-foreground">
					Writes {totalEvents} event{totalEvents === 1 ? '' : 's'} through sync — nothing is deleted.
				</p>
				<AlertDialog.Root>
					<AlertDialog.Trigger class={buttonVariants({ size: 'sm' })} disabled={busy}>
						Restore everything shown
					</AlertDialog.Trigger>
					<AlertDialog.Content>
						<AlertDialog.Header>
							<AlertDialog.Title>Rewind {diffs.length} titles?</AlertDialog.Title>
							<AlertDialog.Description>
								This writes {totalEvents} events, moving {diffs.length} titles back to how they were
								{relativeAgo(stop.ms)}. Nothing is deleted — the changes sync to your other devices
								like any other edit.
							</AlertDialog.Description>
						</AlertDialog.Header>
						<AlertDialog.Footer>
							<AlertDialog.Cancel>Keep as is</AlertDialog.Cancel>
							<Button variant="outline" onclick={() => restore(diffs)} disabled={busy}>
								Rewind them
							</Button>
						</AlertDialog.Footer>
					</AlertDialog.Content>
				</AlertDialog.Root>
			</div>
		{/if}
	</section>

	<p class="px-1 text-xs text-muted-foreground">
		Rewind replays this device's copy of the log — everything it has recorded or synced. Changes
		made on your other devices appear here once they sync.
	</p>
</main>
