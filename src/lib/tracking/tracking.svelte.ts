/**
 * Reactive per-title tracking state for the detail page. Wraps the client event
 * pipeline (`recordEvent`) and the local IndexedDB projections behind runes, so the
 * page and its child controls (`TrackingControls`, the next-episode row, season
 * cards) all read one source of truth and re-render optimistically after each write.
 *
 * Construct one per media id (with the show's seasons, empty for movies); call
 * {@link load} on mount and whenever the id changes. All writes route through
 * {@link recordEvent} — local event + optimistic projection — then reload.
 */
import { SvelteSet } from 'svelte/reactivity';
import { getEpisodeWatches, getTrackingByMediaId, recordEvent } from '$lib/client/idb';
import type { TrackingStatus } from '$lib/sync/events';
import {
	allEpisodes,
	isSeasonFullyWatched,
	nextEpisode,
	reconciledStatus,
	seasonEpisodes,
	toTrackingView,
	statusEventType,
	nextFavorite,
	watchedKey,
	type EpisodeCoord,
	type SeasonCounts,
	type TrackingView
} from './actions';

export class TrackingState {
	readonly mediaId: string;
	/** Season episode counts (empty for movies) — needed to derive completion and "season watched". */
	readonly seasons: SeasonCounts[];
	/** Current tracking view (untracked, or status + favorite). */
	view = $state<TrackingView>({ tracked: false });
	/** Watched-episode keys (`"season:episode"`). */
	watched = $state<SvelteSet<string>>(new SvelteSet());
	/** False until the first IndexedDB read resolves — controls render disabled meanwhile. */
	ready = $state(false);
	/** True while a write is in flight, to disable controls and prevent double-submits. */
	busy = $state(false);

	constructor(mediaId: string, seasons: SeasonCounts[] = []) {
		this.mediaId = mediaId;
		this.seasons = seasons;
	}

	/** Load tracking + episode-watched state from IndexedDB into the reactive fields. */
	async load(): Promise<void> {
		this.view = toTrackingView(await getTrackingByMediaId(this.mediaId));
		const episodes = await getEpisodeWatches(this.mediaId);
		this.watched = new SvelteSet(
			episodes.filter((e) => e.watched).map((e) => watchedKey(e.season, e.episode))
		);
		this.ready = true;
	}

	/** Whether a given episode is marked watched. */
	isWatched(season: number, episode: number): boolean {
		return this.watched.has(watchedKey(season, episode));
	}

	/** Whether every episode of a season is watched (so "mark season watched" can be hidden). */
	isSeasonWatched(season: SeasonCounts): boolean {
		return isSeasonFullyWatched(season, this.watched);
	}

	/** The next episode to watch, or null when the show is fully watched. */
	nextEpisode(): EpisodeCoord | null {
		return nextEpisode(this.seasons, this.watched);
	}

	async #run(work: () => Promise<void>): Promise<void> {
		this.busy = true;
		try {
			await work();
			await this.load();
		} finally {
			this.busy = false;
		}
	}

	/** Add the title to the watchlist as "want to watch". */
	add(): Promise<void> {
		return this.#run(() =>
			recordEvent('tracking.added', this.mediaId, { status: 'want_to_watch' })
		);
	}

	/** Set the status — an add on an untracked title, otherwise a status change. */
	setStatus(status: TrackingStatus): Promise<void> {
		return this.#run(() =>
			statusEventType(this.view) === 'tracking.added'
				? recordEvent('tracking.added', this.mediaId, { status })
				: recordEvent('tracking.status_changed', this.mediaId, { status })
		);
	}

	/** Toggle favorite (favoriting an untracked title implicitly adds it). */
	toggleFavorite(): Promise<void> {
		return this.#run(() =>
			recordEvent('tracking.favorite_toggled', this.mediaId, { favorite: nextFavorite(this.view) })
		);
	}

	/** Remove the title from all lists (tombstone). */
	remove(): Promise<void> {
		return this.#run(() => recordEvent('tracking.removed', this.mediaId, {}));
	}

	/** Toggle a single episode's watched state, then reconcile the show's status. */
	setEpisodeWatched(season: number, episode: number, watchedNow: boolean): Promise<void> {
		return this.#run(async () => {
			await recordEvent(watchedNow ? 'episode.watched' : 'episode.unwatched', this.mediaId, {
				season,
				episode
			});
			await this.#reconcileStatus();
		});
	}

	/** Mark every episode of one season watched (bulk), then reconcile the show's status. */
	markSeasonWatched(season: SeasonCounts): Promise<void> {
		return this.#run(async () => {
			await this.#seedWatched(seasonEpisodes(season));
			await this.#reconcileStatus();
		});
	}

	/**
	 * Mark the whole series watched: every real episode watched, and the status set to
	 * completed. Bulk — one `episode.watched` per episode (the sync push cap bounds delivery).
	 */
	markSeriesWatched(): Promise<void> {
		return this.#run(async () => {
			await this.#seedWatched(allEpisodes(this.seasons));
			await recordEvent('tracking.status_changed', this.mediaId, { status: 'completed' });
		});
	}

	async #seedWatched(episodes: EpisodeCoord[]): Promise<void> {
		for (const { season, episode } of episodes) {
			await recordEvent('episode.watched', this.mediaId, { season, episode });
		}
	}

	/**
	 * Move the status in line with episode progress (completion sequence). Reads the freshly
	 * projected episode counts, so it must run after the episode event has been applied. Only
	 * touches a tracked, non-DNF row (see {@link reconciledStatus}).
	 */
	async #reconcileStatus(): Promise<void> {
		const total = allEpisodes(this.seasons).length;
		if (total === 0) return;
		const row = await getTrackingByMediaId(this.mediaId);
		if (!row || row.removed) return;
		const episodes = await getEpisodeWatches(this.mediaId);
		const watchedCount = episodes.filter((e) => e.watched && e.season >= 1).length;
		const next = reconciledStatus(row.status, watchedCount, total);
		if (next) await recordEvent('tracking.status_changed', this.mediaId, { status: next });
	}
}
