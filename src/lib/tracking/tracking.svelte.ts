/**
 * Reactive per-title tracking state for the detail page. Wraps the client event
 * pipeline (`recordEvent`) and the local IndexedDB projections behind runes, so the
 * page and its child controls (`TrackingControls`, the next-episode row, season
 * cards) all read one source of truth and re-render optimistically after each write.
 *
 * Construct one per media id (with the show's media record); call {@link load} on mount and
 * whenever the id changes. Episode metadata (with air dates) is read from IndexedDB, populated
 * by the media channel; watchability is derived from those air dates. All writes route through
 * {@link recordEvent} — local event + optimistic projection — then reload.
 */
import { SvelteSet } from 'svelte/reactivity';
import {
	getEpisodeWatches,
	getEpisodes,
	getTrackingByMediaId,
	putMedia,
	recordEvent
} from '$lib/client/idb';
import { sync } from '$lib/client/sync/engine.svelte';
import type { MediaRecord, TrackingStatus } from '$lib/sync/events';
import {
	airedEpisodes,
	isSeasonFullyWatched,
	nextEpisode,
	todayIso,
	toTrackingView,
	statusEventType,
	nextFavorite,
	watchedKey,
	type EpisodeAir,
	type EpisodeCoord,
	type TrackingView
} from './actions';
import { reconcileStatus } from './reconcile';

export class TrackingState {
	readonly mediaId: string;
	/** Whether TMDB considers the show still in production — feeds completion reconciliation. */
	readonly #inProduction: boolean | null;
	/** Per-episode metadata (coords + air dates), loaded from IndexedDB (empty for movies / unsynced). */
	episodes = $state<EpisodeAir[]>([]);
	/** Current tracking view (untracked, or status + favorite). */
	view = $state<TrackingView>({ tracked: false });
	/** Watched-episode keys (`"season:episode"`). */
	watched = $state<SvelteSet<string>>(new SvelteSet());
	/** False until the first IndexedDB read resolves — controls render disabled meanwhile. */
	ready = $state(false);
	/** True while a write is in flight, to disable controls and prevent double-submits. */
	busy = $state(false);

	/** The title's media snapshot (from the detail page's TMDB data), cached locally on track. */
	readonly #media: MediaRecord | null;

	constructor(mediaId: string, media: MediaRecord | null = null) {
		this.mediaId = mediaId;
		this.#media = media;
		this.#inProduction = media?.inProduction ?? null;
	}

	/** Load tracking + episode metadata + episode-watched state from IndexedDB. */
	async load(): Promise<void> {
		this.view = toTrackingView(await getTrackingByMediaId(this.mediaId));
		this.episodes = (await getEpisodes(this.mediaId)).map((e) => ({
			season: e.season,
			episode: e.episode,
			airDate: e.airDate
		}));
		const watches = await getEpisodeWatches(this.mediaId);
		this.watched = new SvelteSet(
			watches.filter((e) => e.watched).map((e) => watchedKey(e.season, e.episode))
		);
		this.ready = true;
	}

	/** Whether a given episode is marked watched. */
	isWatched(season: number, episode: number): boolean {
		return this.watched.has(watchedKey(season, episode));
	}

	/** Whether every aired episode of a season is watched (so "mark season watched" can be hidden). */
	isSeasonWatched(seasonNumber: number): boolean {
		return isSeasonFullyWatched(this.episodes, seasonNumber, this.watched, todayIso());
	}

	/** The next aired episode to watch, or null when caught up to what's aired. */
	nextEpisode(): EpisodeCoord | null {
		return nextEpisode(this.episodes, this.watched, todayIso());
	}

	async #run(work: () => Promise<void>): Promise<void> {
		this.busy = true;
		try {
			// Cache the media locally so this device renders lists offline and has identity to
			// push on the media channel (idempotent; the snapshot comes from the detail page).
			if (this.#media) await putMedia(this.#media);
			await work();
			await this.load();
			sync.requestSync(); // nudge a push so the change reaches the server promptly
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

	/**
	 * Remove the title from all lists (tombstone). Removing a series also **clears its episode
	 * watches** — an unwatch per watched episode, so a later re-add starts with a clean history.
	 * Event-sourced and rebuild-safe: the unwatches live in the log and (being newer) win LWW, so
	 * a replay/re-pull can't resurrect the old progress.
	 */
	remove(): Promise<void> {
		return this.#run(async () => {
			const watches = await getEpisodeWatches(this.mediaId);
			for (const e of watches) {
				if (e.watched) {
					await recordEvent('episode.unwatched', this.mediaId, {
						season: e.season,
						episode: e.episode
					});
				}
			}
			await recordEvent('tracking.removed', this.mediaId, {});
		});
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

	/** Mark every **aired** episode of one season watched (bulk), then reconcile the show's status. */
	markSeasonWatched(seasonNumber: number): Promise<void> {
		return this.#run(async () => {
			const today = todayIso();
			await this.#seedWatched(
				airedEpisodes(
					this.episodes.filter((e) => e.season === seasonNumber),
					today
				)
			);
			await this.#reconcileStatus();
		});
	}

	/**
	 * Mark the whole series watched: every **aired** episode watched, and the status set to
	 * completed. Bulk — one `episode.watched` per episode (the sync push cap bounds delivery).
	 */
	markSeriesWatched(): Promise<void> {
		return this.#run(async () => {
			await this.#seedWatched(airedEpisodes(this.episodes, todayIso()));
			await recordEvent('tracking.status_changed', this.mediaId, { status: 'completed' });
		});
	}

	async #seedWatched(episodes: EpisodeCoord[]): Promise<void> {
		for (const { season, episode } of episodes) {
			await recordEvent('episode.watched', this.mediaId, { season, episode });
		}
	}

	/** Move the status in line with episode progress (completion sequence) — see {@link reconcileStatus}. */
	#reconcileStatus(): Promise<void> {
		return reconcileStatus(this.mediaId, this.episodes, this.#inProduction);
	}
}
