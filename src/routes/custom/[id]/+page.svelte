<script lang="ts">
	import { untrack } from 'svelte';
	import { goto, invalidate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import BackButton from '$lib/components/back-button.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import ConfirmDialog from '$lib/components/media/confirm-dialog.svelte';
	import CustomMediaForm from '$lib/components/media/custom-media-form.svelte';
	import MediaBadge from '$lib/components/media/media-badge.svelte';
	import MediaTypeLabel from '$lib/components/media/media-type-label.svelte';
	import PosterTile from '$lib/components/media/poster-tile.svelte';
	import TrackingControls from '$lib/components/media/tracking-controls.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { putCustomMedia } from '$lib/client/idb';
	import { sync } from '$lib/client/sync/engine.svelte';
	import { createCustomMedia, toCustomMediaInput } from '$lib/custom-media';
	import { TrackingState } from '$lib/tracking/tracking.svelte';
	import { isAired, todayIso } from '$lib/tracking/actions';
	import type { CustomMediaInput } from '$lib/validation/custom-media';
	import CheckIcon from '@lucide/svelte/icons/check';
	import FileQuestionIcon from '@lucide/svelte/icons/file-question';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const entry = $derived(data.entry);
	const today = todayIso();

	// TrackingState without a media record — the custom row is already in the local store.
	const tracking = $derived.by(() => {
		const id = data.id;
		return untrack(() => new TrackingState(id, null));
	});
	$effect(() => {
		void sync.revision;
		tracking.load();
	});
	$effect(() => {
		tracking.updateSeasons(
			data.seasons.map((s) => ({
				seasonNumber: s.seasonNumber,
				episodeCount: s.episodeCount,
				airDate: s.airDate
			}))
		);
		tracking.updateInProduction(entry?.inProduction ?? null);
	});

	// Season selector, defaulting to wherever the user left off.
	let selectedSeason = $state<number | null>(null);
	$effect(() => {
		if (selectedSeason !== null || data.seasons.length === 0) return;
		const next = tracking.nextEpisode();
		selectedSeason = next?.season ?? data.seasons[0].seasonNumber;
	});
	const seasonEpisodes = $derived(
		selectedSeason === null ? [] : data.episodes.filter((e) => e.season === selectedSeason)
	);

	let editOpen = $state(false);
	let saving = $state(false);
	let removeOpen = $state(false);

	const editInitial = $derived<CustomMediaInput | undefined>(
		entry ? toCustomMediaInput(entry, data.seasons) : undefined
	);

	async function saveEdit(input: CustomMediaInput) {
		if (!entry || saving) return;
		saving = true;
		try {
			// Same id, so this rewrites the entry rather than forking a second one. Seasons and
			// episodes are rebuilt from the form, and the server reconciles the child rows.
			await putCustomMedia(createCustomMedia(input, { id: entry.id }));
			sync.requestSync();
			editOpen = false;
			await invalidate('app:custom-media');
		} finally {
			saving = false;
		}
	}

	async function removeEntry() {
		await tracking.remove();
		removeOpen = false;
		await goto(resolve('/'));
	}
</script>

<svelte:head>
	<title>{entry ? `${entry.title} · Marquee` : 'Marquee'}</title>
</svelte:head>

<PageHeader>
	<div class="flex items-center gap-3">
		<BackButton />
		<span class="truncate font-medium">{entry?.title ?? ''}</span>
	</div>
</PageHeader>

<main class="mx-auto flex w-full max-w-2xl flex-col gap-5 px-5 pt-3 pb-tab-bar">
	{#if !entry}
		<EmptyState
			icon={FileQuestionIcon}
			message="This entry hasn't reached this device yet. It'll appear once your library finishes syncing."
		>
			{#snippet action()}
				<Button variant="outline" onclick={() => invalidate('app:custom-media')}>Check again</Button
				>
			{/snippet}
		</EmptyState>
	{:else}
		<div class="flex gap-4">
			<div class="w-28 shrink-0 sm:w-32">
				<PosterTile type={entry.type} posterUrl={null} alt={entry.title} isCustom />
			</div>
			<div class="flex min-w-0 flex-1 flex-col gap-2">
				<h1 class="text-xl leading-tight font-semibold">{entry.title}</h1>
				<div class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
					<MediaTypeLabel type={entry.type} year={entry.year} />
				</div>
				<div class="flex flex-wrap items-center gap-2">
					<MediaBadge variant="custom">Not yet matched</MediaBadge>
				</div>
			</div>
		</div>

		{#if !tracking.ready}
			<div class="flex items-center gap-2" aria-hidden="true">
				<Skeleton class="h-9 w-44 rounded-full" />
				<Skeleton class="size-9 rounded-full" />
			</div>
		{:else}
			<TrackingControls {tracking} type={entry.type} />
		{/if}

		{#if entry.overview}
			<p class="text-sm leading-relaxed text-muted-foreground">{entry.overview}</p>
		{/if}

		<div class="flex flex-wrap gap-2">
			<Button variant="outline" size="sm" onclick={() => (editOpen = true)}>
				<PencilIcon class="size-4" />
				Edit details
			</Button>
		</div>

		{#if entry.type === 'show' && data.seasons.length > 0}
			<section class="flex flex-col gap-3">
				<h2 class="text-sm font-medium">Episodes</h2>
				{#if data.seasons.length > 1}
					<div class="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1">
						{#each data.seasons as season (season.seasonNumber)}
							<Button
								variant={selectedSeason === season.seasonNumber ? 'default' : 'outline'}
								size="sm"
								class="shrink-0"
								onclick={() => (selectedSeason = season.seasonNumber)}
							>
								Season {season.seasonNumber}
							</Button>
						{/each}
					</div>
				{/if}
				<ul class="flex flex-col">
					{#each seasonEpisodes as episode (`${episode.season}x${episode.episode}`)}
						{@const watched = tracking.isWatched(episode.season, episode.episode)}
						<li class="flex items-center gap-3 border-b border-border py-2 last:border-b-0">
							<span class="w-10 shrink-0 text-sm text-muted-foreground">
								E{episode.episode}
							</span>
							<span class="min-w-0 flex-1 truncate text-sm">
								{episode.name || `Episode ${episode.episode}`}
							</span>
							{#if isAired(episode, today)}
								<Button
									variant={watched ? 'default' : 'outline'}
									size="icon"
									class="size-8 shrink-0 rounded-full"
									aria-pressed={watched}
									aria-label={`Mark season ${episode.season} episode ${episode.episode} ${
										watched ? 'unwatched' : 'watched'
									}`}
									disabled={tracking.busy}
									onclick={() =>
										tracking.setEpisodeWatched(episode.season, episode.episode, !watched)}
								>
									<CheckIcon class="size-4" />
								</Button>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{:else if entry.type === 'show'}
			<p class="text-sm text-muted-foreground">
				No seasons yet. Add them under <span class="font-medium">Edit details</span> to tick episodes
				off as you watch.
			</p>
		{/if}

		<div class="pt-2">
			<Button
				variant="ghost"
				size="sm"
				class="text-destructive"
				onclick={() => (removeOpen = true)}
			>
				Delete this entry
			</Button>
		</div>
	{/if}
</main>

{#if entry}
	<CustomMediaForm bind:open={editOpen} initial={editInitial} busy={saving} onsubmit={saveEdit} />
	<ConfirmDialog
		bind:open={removeOpen}
		title="Delete this entry?"
		description="It comes off your lists along with anything you've marked watched. The entry stays searchable so you can add it back."
		confirmLabel="Delete"
		confirmVariant="destructive"
		busy={tracking.busy}
		onconfirm={removeEntry}
	/>
{/if}
