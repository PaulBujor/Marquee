<script lang="ts">
	import CreditList from './credit-list.svelte';
	import MediaTypeLabel from './media-type-label.svelte';
	import PosterTile from './poster-tile.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { compareCredits, creditsFromDetail } from '$lib/credits';
	import { posterUrl } from '$lib/media.js';
	import type { ClientMedia, ClientSeason } from '$lib/client/idb';
	import type { MediaCredit } from '$lib/sync/events';
	import type { MediaDetail, MediaSearchResult } from '$lib/server/tmdb';

	/**
	 * A custom entry beside the database title it might be, so linking is a decision rather than a
	 * guess from the title alone. Titles collide constantly — remakes, translations, unrelated films
	 * a decade apart — and a link replays the user's whole watch history onto the target, so it's
	 * worth being sure. Cast and crew are what actually settle it, which is why they're here.
	 *
	 * Presentational: the parent owns fetching the candidate's detail and performing the link.
	 */
	interface Props {
		entry: ClientMedia;
		entrySeasons: ClientSeason[];
		entryCredits: MediaCredit[];
		candidate: MediaSearchResult;
		/** The candidate's full detail; null while it loads or if it couldn't be fetched. */
		detail: MediaDetail | null;
		loading?: boolean;
		failed?: boolean;
		busy?: boolean;
		onlink: () => void;
		onback: () => void;
	}
	let {
		entry,
		entrySeasons,
		entryCredits,
		candidate,
		detail,
		loading = false,
		failed = false,
		busy = false,
		onlink,
		onback
	}: Props = $props();

	const candidateCredits = $derived(detail ? creditsFromDetail(detail) : []);
	const overlap = $derived(compareCredits(entryCredits, candidateCredits));

	const entryEpisodes = $derived(entrySeasons.reduce((n, s) => n + s.episodeCount, 0));
	const candidateSeasons = $derived(detail?.seasons.filter((s) => s.seasonNumber >= 1) ?? []);
	const candidateEpisodes = $derived(candidateSeasons.reduce((n, s) => n + s.episodeCount, 0));

	function structure(seasons: number, episodes: number): string {
		return `${seasons} ${seasons === 1 ? 'season' : 'seasons'}, ${episodes} ${
			episodes === 1 ? 'episode' : 'episodes'
		}`;
	}

	/** What the credit overlap says, in the terms the user is actually deciding in. */
	const verdict = $derived.by(() => {
		if (!detail) return null;
		if (overlap.total === 0) {
			return "You haven't listed anyone on your entry, so there's nothing to cross-check. Adding a director or a couple of names makes matches like this easy to judge.";
		}
		if (overlap.matched === 0) {
			return `None of the ${overlap.total} ${overlap.total === 1 ? 'person' : 'people'} you listed appear here. That's a reason to look twice — though it can also just mean you filed them differently.`;
		}
		return `${overlap.matched} of the ${overlap.total} ${overlap.total === 1 ? 'person' : 'people'} you listed ${overlap.matched === 1 ? 'appears' : 'appear'} here too, highlighted below.`;
	});
</script>

<div class="flex flex-col gap-4">
	<div class="flex items-center justify-between gap-2">
		<h2 class="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
			Is this the same title?
		</h2>
		<Button variant="ghost" size="sm" onclick={onback} disabled={busy}>Back to results</Button>
	</div>

	<div class="grid gap-4 sm:grid-cols-2">
		<!-- The user's entry -->
		<section class="flex flex-col gap-3 rounded-lg border border-dashed border-border p-3">
			<h3 class="text-xs font-medium text-muted-foreground">Your entry</h3>
			<div class="flex gap-3">
				<div class="w-14 shrink-0">
					<PosterTile type={entry.type} posterUrl={null} alt={entry.title} isCustom />
				</div>
				<div class="flex min-w-0 flex-1 flex-col gap-1">
					<span class="text-sm leading-tight font-medium">{entry.title}</span>
					<span class="text-xs text-muted-foreground">
						<MediaTypeLabel type={entry.type} year={entry.year} />
					</span>
					{#if entry.type === 'show'}
						<span class="text-xs text-muted-foreground">
							{structure(entrySeasons.length, entryEpisodes)}
						</span>
					{/if}
				</div>
			</div>
			{#if entry.overview}
				<p class="line-clamp-4 text-sm text-muted-foreground">{entry.overview}</p>
			{/if}
			<CreditList
				credits={entryCredits}
				highlight={overlap.shared}
				empty="No cast or crew listed."
			/>
		</section>

		<!-- The candidate -->
		<section class="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
			<h3 class="text-xs font-medium text-muted-foreground">Database entry</h3>
			<div class="flex gap-3">
				<div class="w-14 shrink-0">
					<PosterTile
						type={candidate.type}
						posterUrl={posterUrl(candidate.posterPath)}
						alt={candidate.title}
					/>
				</div>
				<div class="flex min-w-0 flex-1 flex-col gap-1">
					<span class="text-sm leading-tight font-medium">{candidate.title}</span>
					<span class="text-xs text-muted-foreground">
						<MediaTypeLabel type={candidate.type} year={candidate.year} />
					</span>
					{#if candidate.type === 'show' && detail}
						<span class="text-xs text-muted-foreground">
							{structure(candidateSeasons.length, candidateEpisodes)}
						</span>
					{/if}
				</div>
			</div>
			{#if candidate.overview}
				<p class="line-clamp-4 text-sm text-muted-foreground">{candidate.overview}</p>
			{/if}
			{#if loading}
				<div class="flex flex-col gap-2" aria-hidden="true">
					<Skeleton class="h-4 w-3/4" />
					<Skeleton class="h-4 w-2/3" />
					<Skeleton class="h-4 w-1/2" />
				</div>
			{:else if failed}
				<p class="text-sm text-muted-foreground">
					Couldn't load its cast and crew just now — you can still link it, or try again in a
					moment.
				</p>
			{:else}
				<CreditList
					credits={candidateCredits}
					highlight={overlap.shared}
					empty="No cast or crew listed."
				/>
			{/if}
		</section>
	</div>

	{#if verdict}
		<p class="text-sm text-muted-foreground">{verdict}</p>
	{/if}

	<div class="flex flex-wrap gap-2">
		<Button disabled={busy} onclick={onlink}>
			{busy ? 'Linking…' : 'Yes, link them'}
		</Button>
		<Button variant="ghost" disabled={busy} onclick={onback}>Not this one</Button>
	</div>
</div>
