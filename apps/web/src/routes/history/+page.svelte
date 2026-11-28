<script lang="ts">
	/**
	 * Time travel. The rewind control is a **tape**: a horizontal strip of event tiles scrolling
	 * under a fixed pointer, one tile per event — dragged, flung, wheeled or stepped. The panel
	 * names the event under the pointer and undoes just that event; the bulk restore stays behind
	 * its own confirmation.
	 *
	 * Every undo is a *new* event that pulls the present back — see `restore.ts`.
	 */
	import PageHeader from '#lib/components/page-header.svelte';
	import BackButton from '#lib/components/back-button.svelte';
	import PosterTile from '#lib/components/media/poster-tile.svelte';
	import Tape from '#lib/components/history/tape.svelte';
	import { Button, buttonVariants } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { getAllEvents, getAllMedia, type ClientMedia } from '#lib/client/idb/index.js';
	import { restoreTitles } from '#lib/client/history/restore.js';
	import { sync } from '#lib/client/sync/engine.svelte.js';
	import { DEFAULT_PITCH, PITCHES, dayAnchors, settleIndex } from '#lib/sync/tape.js';
	import {
		STATUS_LABELS,
		compensatingEventCount,
		diffStates,
		eventAtStep,
		eventDiff,
		eventSummary,
		orderedLog,
		relativeAgo,
		stateAtStep,
		summarize,
		touchedAfterStep,
		type TitleDiff
	} from '#lib/sync/history.js';
	import type { EventEnvelope } from '#lib/sync/events.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let events = $state<EventEnvelope[]>([]);
	let media = $state(new Map<string, ClientMedia>());
	/** Epoch ms "now" is measured from for this view of the log. */
	let anchor = $state(Date.now());
	/** The settled event index: `0` is the start of the log, `log.length` is now. */
	let index = $state(0);
	let pitch = $state<number>(PITCHES[DEFAULT_PITCH]);
	let query = $state('');
	let ready = $state(false);
	let busy = $state(false);
	let status = $state('');

	const PITCH_LABELS = ['Range', 'Normal', 'Precise'];

	async function load() {
		const [log, records] = await Promise.all([getAllEvents(), getAllMedia()]);
		events = log;
		media = new Map(records.map((record) => [record.id, record]));
		anchor = Date.now();
		// The first load opens on now; a reload after a write leaves the user where they were.
		if (!ready) index = log.length;
		ready = true;
	}

	// Re-read on every sync that moved data, so another device's events land in the log too.
	$effect(() => {
		if (!data.user) return;
		void sync.revision;
		void load();
	});

	const log = $derived(orderedLog(events));
	const selected = $derived(eventAtStep(log, index));
	const eventChanges = $derived(eventDiff(log, index));
	const stepState = $derived(stateAtStep(log, index));
	const nowState = $derived(stateAtStep(log, log.length));
	const counts = $derived(summarize(stepState));
	const sinceDiffs = $derived(diffStates(nowState, stepState));
	const touched = $derived(touchedAfterStep(log, index).length);
	const chips = $derived(dayAnchors(log));
	const selectedAgo = $derived(selected ? relativeAgo(anchor - selected.clientCreatedAt) : 'now');
	const eventUndoCount = $derived(eventChanges ? compensatingEventCount([eventChanges]) : 0);
	const tapeValue = $derived(
		selected ? `${selectedAgo}, ${eventSummary(selected)}` : 'the start of the log'
	);

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

	function record(mediaId: string | undefined): ClientMedia | undefined {
		return mediaId ? media.get(mediaId) : undefined;
	}

	/** The 3–5 character glyph a tile carries at the wider pitches. */
	function shortLabel(event: EventEnvelope): string {
		switch (event.type) {
			case 'episode.watched':
			case 'episode.unwatched': {
				const { season, episode } = event.payload as { season: number; episode: number };
				return `S${season}E${episode}`;
			}
			case 'tracking.rated': {
				const { rating } = event.payload as { rating: number | null };
				return rating === null ? 'unrated' : `★${rating}`;
			}
			case 'tracking.added':
				return 'added';
			case 'tracking.removed':
				return 'removed';
			case 'tracking.favorite_toggled':
				return '♥';
			default:
				return 'status';
		}
	}

	/** Titles matching the jump filter, newest first — a three-month-old event without a long drag. */
	const matches = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (q.length < 2) return [];
		const found: { step: number; title: string; at: number }[] = [];
		for (let i = log.length - 1; i >= 0 && found.length < 5; i--) {
			const title = media.get(log[i].entityId)?.title;
			if (title && title.toLowerCase().includes(q)) {
				found.push({ step: i + 1, title, at: log[i].clientCreatedAt });
			}
		}
		return found;
	});

	function jumpTo(step: number): void {
		index = settleIndex(step, log.length);
		query = '';
	}

	/** What the since-list says changed about one title, in the order events are written. */
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
			status = `Rewound ${list.length} title${list.length === 1 ? '' : 's'} — ${written} event${written === 1 ? '' : 's'} written.`;
		} catch (err) {
			console.error('history: rewind failed', err);
			status = "Couldn't rewind that. Please try again.";
		} finally {
			busy = false;
		}
	}
</script>

{#snippet tile(step: number, isGhost: boolean)}
	{#if isGhost}
		<div class="h-full w-full rounded-sm bg-border/60"></div>
	{:else if step === 0}
		<div
			class="flex h-full w-full items-center justify-center rounded-sm border border-dashed border-border text-[9px] text-muted-foreground"
		>
			start
		</div>
	{:else}
		{@const event = log[step - 1]}
		{@const item = record(event.entityId)}
		<div class="flex h-full w-full flex-col items-center gap-1" class:opacity-60={step !== index}>
			<div class="flex w-full flex-1 items-center justify-center overflow-hidden">
				<PosterTile
					type={item?.type ?? 'movie'}
					mediaId={event.entityId}
					posterPath={item?.posterPath ?? null}
					isCustom={item?.source === 'custom'}
					alt={item?.title ?? ''}
				/>
			</div>
			{#if pitch >= PITCHES[1]}
				<span class="w-full truncate text-center text-[9px] leading-none text-muted-foreground">
					{shortLabel(event)}
				</span>
			{/if}
		</div>
	{/if}
{/snippet}

<svelte:head><title>Rewind · Marquee</title></svelte:head>

<PageHeader>
	<div class="flex min-h-10 items-center gap-3">
		<BackButton />
		<h1 class="font-serif text-xl font-semibold">Rewind</h1>
	</div>
</PageHeader>

<main class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 pt-3 pb-tab-bar">
	<section class="flex flex-col gap-3 rounded-xl border bg-card p-4">
		<div class="flex flex-col gap-1">
			<Input
				bind:value={query}
				placeholder="Jump to a title…"
				class="h-9 text-sm"
				aria-label="Jump to a title"
			/>
			{#if matches.length > 0}
				<ul class="flex flex-col gap-1">
					{#each matches as match (match.step)}
						<li>
							<button
								type="button"
								class="flex w-full items-baseline justify-between gap-3 rounded-sm px-2 py-1 text-left text-sm hover:bg-secondary"
								onclick={() => jumpTo(match.step)}
							>
								<span class="truncate">{match.title}</span>
								<span class="shrink-0 text-xs text-muted-foreground">
									{relativeAgo(anchor - match.at)}
								</span>
							</button>
						</li>
					{/each}
				</ul>
			{:else if query.trim().length >= 2}
				<p class="px-2 text-xs text-muted-foreground">No event for that title.</p>
			{/if}
		</div>

		{#if chips.length > 0}
			<div class="no-scrollbar flex items-center gap-1 overflow-x-auto">
				{#each chips as chip (chip.step)}
					<Button
						variant={index === chip.step ? 'default' : 'outline'}
						size="sm"
						class="shrink-0"
						onclick={() => jumpTo(chip.step)}
					>
						{chip.label}
					</Button>
				{/each}
			</div>
		{/if}

		{#if ready && log.length === 0}
			<p class="py-10 text-center text-sm text-muted-foreground">
				Nothing to rewind yet — your history starts with your first tracked title.
			</p>
		{:else}
			<Tape length={log.length} bind:index {pitch} valueLabel={tapeValue} {tile} />

			<div class="flex flex-wrap items-center justify-between gap-2">
				<div
					class="inline-flex items-center gap-0.5 rounded-lg bg-secondary p-0.5"
					role="group"
					aria-label="Tape zoom"
				>
					{#each PITCHES as level, i (level)}
						<Button
							variant={pitch === level ? 'default' : 'ghost'}
							size="sm"
							aria-pressed={pitch === level}
							onclick={() => (pitch = level)}
						>
							{PITCH_LABELS[i]}
						</Button>
					{/each}
				</div>
				<Button
					variant="outline"
					size="sm"
					disabled={index >= log.length}
					onclick={() => jumpTo(log.length)}
				>
					Back to now
				</Button>
			</div>

			<p class="text-xs text-muted-foreground">
				Drag, fling, or scroll the tape · ←/→ one event · PageUp/PageDown ten · Home = now, End =
				the start · event {index} of {log.length}
			</p>
		{/if}
	</section>

	<p class="px-1 text-sm text-primary empty:hidden" role="status" aria-live="polite">{status}</p>

	{#if ready && log.length > 0}
		<section class="flex flex-col gap-3 rounded-xl border bg-card p-4">
			<header class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<h2 class="font-serif text-lg font-semibold">
					{selected ? `Event ${index} of ${log.length}` : 'The start of your log'}
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
				{counts.titles}
				{counts.titles === 1 ? 'title' : 'titles'} · {counts.episodes}
				{counts.episodes === 1 ? 'episode' : 'episodes'} watched at this point · {touched}
				{touched === 1 ? 'title' : 'titles'} touched since
			</p>
		</section>

		{#if sinceDiffs.length > 0}
			<details class="rounded-xl border bg-card p-4">
				<summary class="cursor-pointer text-sm font-medium">
					Changed since this event · {sinceDiffs.length}
					{sinceDiffs.length === 1 ? 'title' : 'titles'}
				</summary>

				<ul class="flex flex-col divide-y pt-2">
					{#each sinceDiffs as diff (diff.mediaId)}
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
						Writes {compensatingEventCount(sinceDiffs)} events through sync — nothing is deleted.
					</p>
					<AlertDialog.Root>
						<AlertDialog.Trigger class={buttonVariants({ size: 'sm' })} disabled={busy}>
							Restore everything shown
						</AlertDialog.Trigger>
						<AlertDialog.Content>
							<AlertDialog.Header>
								<AlertDialog.Title>Rewind {sinceDiffs.length} titles?</AlertDialog.Title>
								<AlertDialog.Description>
									This writes {compensatingEventCount(sinceDiffs)} events, moving {sinceDiffs.length}
									titles back to how they were at event {index} of {log.length}. Nothing is deleted
									— the changes sync to your other devices like any other edit.
								</AlertDialog.Description>
							</AlertDialog.Header>
							<AlertDialog.Footer>
								<AlertDialog.Cancel>Keep as is</AlertDialog.Cancel>
								<Button variant="outline" onclick={() => restore(sinceDiffs)} disabled={busy}>
									Rewind them
								</Button>
							</AlertDialog.Footer>
						</AlertDialog.Content>
					</AlertDialog.Root>
				</div>
			</details>
		{/if}
	{/if}

	<p class="px-1 text-xs text-muted-foreground">
		The tape is one tile per event — no buckets, no skipped history. Zoom out to sweep, in to land
		on a single episode. Rewind replays this device's copy of the log, so changes made on your other
		devices appear here once they sync.
	</p>
</main>
