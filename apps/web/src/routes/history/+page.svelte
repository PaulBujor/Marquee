<script lang="ts">
	/**
	 * Time travel. The dial's primary unit is one **log event**: each detent walks the ordered log,
	 * decimating by distance so a long history still fits the arc, and the panel names the event it
	 * landed on with a one-event undo. The time view (15m … 1mo) is the coarser mode, where the bulk
	 * "restore everything shown" lives.
	 *
	 * Every undo is a *new* event that pulls the present back — see `restore.ts`.
	 */
	import PageHeader from '#lib/components/page-header.svelte';
	import BackButton from '#lib/components/back-button.svelte';
	import PosterTile from '#lib/components/media/poster-tile.svelte';
	import TimeDial from '#lib/components/history/time-dial.svelte';
	import { Button, buttonVariants } from '#lib/components/ui/button/index.js';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { getAllEvents, getAllMedia, type ClientMedia } from '#lib/client/idb/index.js';
	import { restoreTitles } from '#lib/client/history/restore.js';
	import { haptics } from '#lib/client/history/haptics.svelte.js';
	import { sync } from '#lib/client/sync/engine.svelte.js';
	import { prefersReducedMotion } from 'svelte/motion';
	import {
		REWIND_STOPS,
		STATUS_LABELS,
		backFromProgress,
		backStep,
		compensatingEventCount,
		densityFor,
		diffStates,
		eventAtStep,
		eventDiff,
		eventSummary,
		orderedLog,
		relativeAgo,
		stateAt,
		stateAtStep,
		summarize,
		touchedAfterStep,
		touchedSince,
		type TitleDiff
	} from '#lib/sync/history.js';
	import type { EventEnvelope } from '#lib/sync/events.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let events = $state<EventEnvelope[]>([]);
	let media = $state(new Map<string, ClientMedia>());
	/** Epoch ms "now" is measured from for this view of the log. */
	let anchor = $state(Date.now());
	let mode = $state<'events' | 'time'>('events');
	/** Event mode: how many events back from now the dial sits. */
	let back = $state(0);
	/** Time mode: which rewind stop is selected. */
	let stopIndex = $state(0);
	/** Makes every detent exactly one event, whatever the density. */
	let fine = $state(false);
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

	// Re-read on every sync that moved data, so another device's events land in the log too.
	$effect(() => {
		if (!data.user) return;
		void sync.revision;
		void load();
	});

	const reduced = $derived(prefersReducedMotion.current);
	const log = $derived(orderedLog(events));

	// Event mode — the primary view.
	const distance = $derived(Math.min(back, log.length));
	const step = $derived(log.length - distance);
	const selected = $derived(eventAtStep(log, step));
	const eventChanges = $derived(eventDiff(log, step));
	const eventState = $derived(stateAtStep(log, step));
	const eventCounts = $derived(summarize(eventState));
	const eventStrip = $derived(touchedAfterStep(log, step).slice(0, 20));
	const selectedAgo = $derived(selected ? relativeAgo(anchor - selected.clientCreatedAt) : 'now');
	const density = $derived(densityFor(distance, fine));

	// Time mode — the same library, bucketed by wall clock.
	const LAST_STOP = REWIND_STOPS.length - 1;
	const stop = $derived(REWIND_STOPS[stopIndex]);
	const cutoff = $derived(anchor - stop.ms);
	const then = $derived(stateAt(log, cutoff));
	const timeDiffs = $derived(diffStates(stateAtStep(log, log.length), then));
	const timeCounts = $derived(summarize(then));
	const timeStrip = $derived(touchedSince(log, cutoff, anchor).slice(0, 20));

	const progress = $derived(
		mode === 'events' ? (log.length === 0 ? 0 : distance / log.length) : stopIndex / LAST_STOP
	);
	const dialLabels = $derived(mode === 'time' ? REWIND_STOPS.map((s) => s.label) : undefined);
	const dialValue = $derived(
		mode === 'events'
			? selected
				? `${selectedAgo}, ${eventSummary(selected)}`
				: 'now'
			: `${stop.label}, ${relativeAgo(stop.ms)}`
	);
	const strip = $derived(mode === 'events' ? eventStrip : timeStrip);

	const momentFormat = new Intl.DateTimeFormat(undefined, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});

	function momentAt(ms: number): string {
		return momentFormat.format(new Date(ms));
	}

	function ordinal(n: number): string {
		const suffix =
			n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
		return `${n}${suffix}`;
	}

	const densityLabel = $derived(
		fine || density === 1 ? 'every event' : `every ${ordinal(density)} event`
	);

	function record(mediaId: string | undefined): ClientMedia | undefined {
		return mediaId ? media.get(mediaId) : undefined;
	}

	/** A detent crossing: the position changed, so tick (and say nothing else). */
	function setBack(next: number): void {
		const clamped = Math.max(0, Math.min(log.length, next));
		if (clamped === back) return;
		back = clamped;
		haptics.tick();
	}

	function setStop(next: number): void {
		const clamped = Math.max(0, Math.min(LAST_STOP, next));
		if (clamped === stopIndex) return;
		stopIndex = clamped;
		haptics.tick();
	}

	function seek(position: number, shift: boolean): void {
		if (mode === 'events') setBack(backFromProgress(log.length, position, fine || shift));
		else setStop(Math.round(position * LAST_STOP));
	}

	function detent(direction: 1 | -1, shift: boolean): void {
		if (mode === 'events') setBack(backStep(log.length, back, direction, fine || shift));
		else setStop(stopIndex + direction);
	}

	/** What the time-mode list says changed about one title, in the order events are written. */
	function changes(diff: TitleDiff): string[] {
		const out: string[] = [];
		if (diff.remove) out.push('Off your lists');
		else if (diff.readd) {
			out.push(`Back on your lists · ${STATUS_LABELS[diff.status ?? 'want_to_watch']}`);
		} else if (diff.status) out.push(`Status → ${STATUS_LABELS[diff.status]}`);
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
			// Keep the dial on the same event: the compensating writes are the newest rows.
			if (mode === 'events') back = Math.min(log.length, back + written);
			status = `Rewound ${list.length} title${list.length === 1 ? '' : 's'} — ${written} event${written === 1 ? '' : 's'} written.`;
		} catch (err) {
			console.error('history: rewind failed', err);
			status = "Couldn't rewind that. Please try again.";
		} finally {
			busy = false;
		}
	}

	const eventUndoCount = $derived(eventChanges ? compensatingEventCount([eventChanges]) : 0);
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
		<div class="flex w-full items-center justify-between gap-2">
			<div
				class="inline-flex items-center gap-0.5 rounded-lg bg-secondary p-0.5"
				role="group"
				aria-label="Rewind by"
			>
				<Button
					variant={mode === 'events' ? 'default' : 'ghost'}
					size="sm"
					aria-pressed={mode === 'events'}
					onclick={() => (mode = 'events')}
				>
					Events
				</Button>
				<Button
					variant={mode === 'time' ? 'default' : 'ghost'}
					size="sm"
					aria-pressed={mode === 'time'}
					onclick={() => (mode = 'time')}
				>
					Time
				</Button>
			</div>
			<Button
				variant={fine ? 'default' : 'outline'}
				size="sm"
				aria-pressed={fine}
				onclick={() => (fine = !fine)}
				title="Shift does the same thing while dragging or stepping"
			>
				Fine
			</Button>
		</div>

		<TimeDial
			{progress}
			valueLabel={dialValue}
			labels={dialLabels}
			onseek={seek}
			ondetent={detent}
		/>

		{#if mode === 'events'}
			<p class="font-serif text-2xl font-semibold">
				{selected ? selectedAgo : 'Start of your history'}
			</p>
			<p class="text-xs text-muted-foreground">
				{densityLabel} · event {step} of {log.length}
			</p>
		{:else}
			<p class="font-serif text-2xl font-semibold">{relativeAgo(stop.ms)}</p>
			<p class="text-xs text-muted-foreground">{momentAt(cutoff)}</p>
		{/if}
		<p class="text-center text-xs text-muted-foreground">
			Drag the hand, scroll, or step with the arrow keys · Shift or Fine = one event · Home returns
			to now
		</p>

		{#if strip.length > 0}
			<!-- aria-hidden: the panel below is the accessible account; this is the motion. -->
			<div class="-mx-4 w-full overflow-hidden" aria-hidden="true">
				<ul
					class="flex w-max gap-2 px-4 pt-2 will-change-transform"
					style:transform={`translate3d(${reduced ? 0 : -progress * 220}px, 0, 0)`}
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

	<p class="px-1 text-sm text-primary empty:hidden" role="status" aria-live="polite">{status}</p>

	{#if !ready}
		<section class="rounded-xl border bg-card p-4">
			<p class="py-6 text-center text-sm text-muted-foreground">Loading your history…</p>
		</section>
	{:else if mode === 'events'}
		<section class="flex flex-col gap-3 rounded-xl border bg-card p-4">
			<header class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<h2 class="font-serif text-lg font-semibold">
					{selected ? `Event ${step} of ${log.length}` : 'The start of your log'}
				</h2>
				<p class="text-xs text-muted-foreground">
					{selected ? momentAt(selected.clientCreatedAt) : 'nothing to rewind past'}
				</p>
			</header>

			{#if selected}
				{@const item = record(selected.entityId)}
				<div class="flex items-start gap-3">
					<div class="w-12 shrink-0">
						<PosterTile
							type={item?.type ?? 'movie'}
							mediaId={selected.entityId}
							posterPath={item?.posterPath ?? null}
							isCustom={item?.source === 'custom'}
							alt={item?.title ?? ''}
						/>
					</div>
					<div class="flex min-w-0 flex-1 flex-col gap-0.5">
						<span class="truncate text-sm font-medium">{item?.title ?? 'Unknown title'}</span>
						<span class="text-sm text-muted-foreground">{eventSummary(selected)}</span>
						<span class="text-xs text-muted-foreground">
							{eventChanges
								? `Undo restores the title to just before this event · ${eventUndoCount} event${eventUndoCount === 1 ? '' : 's'}`
								: 'Nothing to undo — a later event already covers this one'}
						</span>
					</div>
					<Button
						variant="outline"
						size="sm"
						disabled={busy || !eventChanges}
						onclick={() => eventChanges && restore([eventChanges])}
						aria-label={`Undo ${eventSummary(selected)} on ${item?.title ?? 'this title'}`}
					>
						Undo
					</Button>
				</div>
			{/if}

			<p class="text-xs text-muted-foreground">
				{eventCounts.titles}
				{eventCounts.titles === 1 ? 'title' : 'titles'} · {eventCounts.episodes}
				{eventCounts.episodes === 1 ? 'episode' : 'episodes'} watched at this point
			</p>
		</section>
	{:else}
		<section class="flex flex-col gap-3 rounded-xl border bg-card p-4">
			<header class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<h2 class="font-serif text-lg font-semibold">As of {relativeAgo(stop.ms)}</h2>
				<p class="text-xs text-muted-foreground">{momentAt(cutoff)}</p>
			</header>

			<p class="text-sm text-muted-foreground">
				{timeCounts.titles}
				{timeCounts.titles === 1 ? 'title' : 'titles'} · {timeCounts.episodes}
				{timeCounts.episodes === 1 ? 'episode' : 'episodes'} watched
			</p>

			{#if timeDiffs.length === 0}
				<p class="py-6 text-center text-sm text-muted-foreground">
					{stopIndex === 0
						? 'This is now — turn the dial back to see what changed.'
						: 'Nothing differs from now at this moment.'}
				</p>
			{:else}
				<ul class="flex flex-col divide-y">
					{#each timeDiffs as diff (diff.mediaId)}
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
						Writes {compensatingEventCount(timeDiffs)} events through sync — nothing is deleted.
					</p>
					<AlertDialog.Root>
						<AlertDialog.Trigger class={buttonVariants({ size: 'sm' })} disabled={busy}>
							Restore everything shown
						</AlertDialog.Trigger>
						<AlertDialog.Content>
							<AlertDialog.Header>
								<AlertDialog.Title>Rewind {timeDiffs.length} titles?</AlertDialog.Title>
								<AlertDialog.Description>
									This writes {compensatingEventCount(timeDiffs)} events, moving {timeDiffs.length}
									titles back to how they were {relativeAgo(stop.ms)}. Nothing is deleted — the
									changes sync to your other devices like any other edit.
								</AlertDialog.Description>
							</AlertDialog.Header>
							<AlertDialog.Footer>
								<AlertDialog.Cancel>Keep as is</AlertDialog.Cancel>
								<Button variant="outline" onclick={() => restore(timeDiffs)} disabled={busy}>
									Rewind them
								</Button>
							</AlertDialog.Footer>
						</AlertDialog.Content>
					</AlertDialog.Root>
				</div>
			{/if}
		</section>
	{/if}

	<p class="px-1 text-xs text-muted-foreground">
		Rewind replays this device's copy of the log — everything it has recorded or synced.
		{#if mode === 'events'}
			Each detent is one event near now and {densityLabel} further back; Shift or Fine always steps exactly
			one. Changes made on your other devices appear here once they sync.
		{:else}
			The stops are wall-clock buckets; the Events view walks the log one event at a time.
		{/if}
	</p>
</main>
