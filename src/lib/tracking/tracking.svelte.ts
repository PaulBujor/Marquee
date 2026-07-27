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
	episodesToMark,
	isSeasonFullyWatched,
	nextEpisode,
	todayIso,
	toTrackingView,
	statusEventType,
	nextFavorite,
	watchedKey,
	type DatedEpisode,
	type EpisodeCoord,
	type SeasonSummary,
	type TrackingView
} from './actions';
import { reconcileStatus } from './reconcile';
import { notifications } from '$lib/state/notifications.svelte.js';

export class TrackingState {
	readonly mediaId: string;
	/** Whether TMDB considers the show still in production — feeds completion reconciliation. */
	readonly #inProduction: boolean | null;
	/** Per-episode metadata (coords + air dates), loaded from IndexedDB (empty for movies / unsynced). */
	episodes = $state<DatedEpisode[]>([]);
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
	/**
	 * Season summaries (count + air date) the detail page holds up-front. They let a bulk "mark
	 * watched" enumerate episodes immediately — before the media channel syncs per-episode air dates
	 * — so a fresh add can be marked watched without the unmark/re-mark dance (MRQ-130).
	 */
	readonly #seasons: SeasonSummary[];

	constructor(mediaId: string, media: MediaRecord | null = null, seasons: SeasonSummary[] = []) {
		this.mediaId = mediaId;
		this.#media = media;
		this.#inProduction = media?.inProduction ?? null;
		this.#seasons = seasons;
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
			// `$state.snapshot` unwraps the record from its Svelte reactive proxy — the detail page's
			// `mediaRecord` derives from `$state` fields, and IndexedDB's structured clone throws on a
			// proxy ("Proxy object could not be cloned").
			if (this.#media) await putMedia($state.snapshot(this.#media));
			await work();
			await this.load();
			sync.requestSync(); // nudge a push so the change reaches the server promptly
		} catch (err) {
			console.error(`tracking: write failed for ${this.mediaId}`, err);
		} finally {
			this.busy = false;
		}
	}

	/** Add the title to the watchlist as "want to watch". */
	add(): Promise<void> {
		notifications.promptContextually();
		return this.#run(() =>
			recordEvent('tracking.added', this.mediaId, { status: 'want_to_watch' })
		);
	}

	/** Set the status — an add on an untracked title, otherwise a status change. */
	setStatus(status: TrackingStatus): Promise<void> {
		notifications.promptContextually();
		return this.#run(() =>
			statusEventType(this.view) === 'tracking.added'
				? recordEvent('tracking.added', this.mediaId, { status })
				: recordEvent('tracking.status_changed', this.mediaId, { status })
		);
	}

	/** Toggle favorite (favoriting an untracked title implicitly adds it). */
	toggleFavorite(): Promise<void> {
		notifications.promptContextually();
		return this.#run(() =>
			recordEvent('tracking.favorite_toggled', this.mediaId, { favorite: nextFavorite(this.view) })
		);
	}

	/**
	 * Set the user's own 1–5 rating (`null` clears it). Only offered once a title's been watched
	 * (see the controls' `canRate`), so it's always already tracked — no implicit add here.
	 */
	setRating(rating: number | null): Promise<void> {
		return this.#run(() => recordEvent('tracking.rated', this.mediaId, { rating }));
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

	/**
	 * Toggle a single episode's watched state, then reconcile the show's status. Marking an episode
	 * on an **untracked** title implicitly adds it as `watching` first (mirrors favoriting).
	 */
	setEpisodeWatched(season: number, episode: number, watchedNow: boolean): Promise<void> {
		return this.#run(async () => {
			if (watchedNow) await this.#ensureTracked('watching');
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
			await this.#ensureTracked('watching');
			await this.#seedWatched(this.#markable(seasonNumber));
			await this.#reconcileStatus();
		});
	}

	/**
	 * Mark the whole series watched: every **aired** episode watched, and the status set to
	 * completed. Bulk — one `episode.watched` per episode (the sync push cap bounds delivery).
	 * Enumerated from the season summaries, so it works the instant a title is added (MRQ-130).
	 */
	markSeriesWatched(): Promise<void> {
		return this.#run(async () => {
			await this.#seedWatched(this.#markable());
			// `added` on an untracked title (asserts the row), else `status_changed`.
			await recordEvent(statusEventType(this.view), this.mediaId, { status: 'completed' });
		});
	}

	/** The episode coords to seed for a bulk mark, from the season summaries + any per-episode data. */
	#markable(seasonNumber?: number): EpisodeCoord[] {
		return episodesToMark(
			this.#seasons,
			this.episodes,
			this.#inProduction,
			todayIso(),
			seasonNumber
		);
	}

	/** Add the title as `status` if it isn't tracked yet, so a watch on an untracked title lands it. */
	async #ensureTracked(status: TrackingStatus): Promise<void> {
		if (!this.view.tracked) {
			notifications.promptContextually();
			await recordEvent('tracking.added', this.mediaId, { status });
		}
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
