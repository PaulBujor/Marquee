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
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import {
	getEpisodeWatches,
	getEpisodes,
	getTrackingByMediaId,
	putMedia,
	recordEvent,
	recordEvents
} from '$lib/client/idb';
import { reportClientError } from '$lib/client/report-error';
import { sync } from '$lib/client/sync/engine.svelte';
import { toast } from 'svelte-sonner';
import type { MediaRecord, TrackingStatus } from '$lib/sync/events';
import {
	episodesToMark,
	hasSufficientEpisodeData,
	isSeasonFullyWatched,
	nextEpisode,
	todayIso,
	statusEventType,
	nextFavorite,
	watchedKey,
	type DatedEpisode,
	type EpisodeCoord,
	type SeasonSummary,
	type TrackingView
} from './actions';
import { toTrackingView } from './derive-status';
import { reconcileStatus } from './reconcile';
import { notifications } from '$lib/state/notifications.svelte.js';

export class TrackingState {
	readonly mediaId: string;
	/**
	 * Whether TMDB considers the show still in production — feeds completion reconciliation.
	 * `$state`, not constructor-frozen, for the same reason as `#seasons`: `title-detail.svelte`
	 * recreates this instance only on media-id change, not on the base→enriched detail upgrade,
	 * so this needs its own update path — see `updateInProduction`.
	 */
	#inProduction = $state<boolean | null>(null);
	/** Per-episode metadata (coords + air dates), loaded from IndexedDB (empty for movies / unsynced). */
	episodes = $state<DatedEpisode[]>([]);
	/** Current tracking view (untracked, or status + favorite). */
	view = $state<TrackingView>({ tracked: false });
	/** Watched-episode keys (`"season:episode"`). */
	watched = $state<SvelteSet<string>>(new SvelteSet());
	/** When each watched episode was marked: `"season:episode"` → epoch ms. */
	episodeWatchedAt = $state<SvelteMap<string, number>>(new SvelteMap());
	/** Epoch ms of the last status change — when a `completed` title became completed. */
	statusUpdatedAt = $state(0);
	/** False until the first IndexedDB read resolves — controls render disabled meanwhile. */
	ready = $state(false);
	/** True while a write is in flight, to disable controls and prevent double-submits. */
	busy = $state(false);

	/** The title's media snapshot (from the detail page's TMDB data), cached locally on track. */
	readonly #media: MediaRecord | null;
	/**
	 * Season summaries (count + air date) the detail page holds up-front. They let a bulk "mark
	 * watched" enumerate episodes immediately — before the media channel syncs per-episode air dates
	 * — so a fresh add can be marked watched without the unmark/re-mark dance. `$state`,
	 * not constructor-frozen: `title-detail.svelte` recreates this instance only when the media id
	 * changes, not when `detail` upgrades from a cached copy to the enriched one, so this
	 * needs its own update path — see `updateSeasons`.
	 */
	#seasons = $state<SeasonSummary[]>([]);

	constructor(mediaId: string, media: MediaRecord | null = null, seasons: SeasonSummary[] = []) {
		this.mediaId = mediaId;
		this.#media = media;
		this.#inProduction = media?.inProduction ?? null;
		this.#seasons = seasons;
	}

	/** Refresh the season summaries — call whenever the page's `detail.seasons` changes. */
	updateSeasons(seasons: SeasonSummary[]): void {
		this.#seasons = seasons;
	}

	/** Refresh production status — call whenever the page's `detail.inProduction` changes. */
	updateInProduction(inProduction: boolean | null): void {
		this.#inProduction = inProduction;
	}

	/** Load tracking + episode metadata + episode-watched state from IndexedDB. */
	async load(): Promise<void> {
		const row = await getTrackingByMediaId(this.mediaId);
		this.episodes = (await getEpisodes(this.mediaId)).map((e) => ({
			season: e.season,
			episode: e.episode,
			airDate: e.airDate
		}));
		const watches = await getEpisodeWatches(this.mediaId);
		const marked = watches.filter((e) => e.watched);
		this.watched = new SvelteSet(marked.map((e) => watchedKey(e.season, e.episode)));
		// The same rows carry the LWW clock of the `episode.watched` event — i.e. when it was marked.
		this.episodeWatchedAt = new SvelteMap(
			marked.map((e) => [watchedKey(e.season, e.episode), e.updatedAt])
		);
		// Status is derived here, every load — not cached from whichever write last happened to have
		// episode/production metadata on hand, so a title that finishes syncing after the user already
		// marked it watched still ends up correct on the next read, with no further write required.
		this.view = toTrackingView(row, {
			type: this.#media?.type ?? 'movie',
			episodes: this.episodes,
			watched: this.watched,
			inProduction: this.#inProduction
		});
		this.statusUpdatedAt = row?.statusUpdatedAt ?? 0;
		this.ready = true;
	}

	/** Whether a given episode is marked watched. */
	isWatched(season: number, episode: number): boolean {
		return this.watched.has(watchedKey(season, episode));
	}

	/** Epoch ms a given episode was marked watched, or null if it isn't watched. */
	watchedAtFor(season: number, episode: number): number | null {
		return this.episodeWatchedAt.get(watchedKey(season, episode)) ?? null;
	}

	/** Epoch ms of the most recent episode watch, or null when nothing is watched. */
	lastEpisodeWatchedAt(): number | null {
		let latest: number | null = null;
		for (const at of this.episodeWatchedAt.values()) {
			if (latest === null || at > latest) latest = at;
		}
		return latest;
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
			// Don't fail silently: the controls re-enable either way, so a swallowed error leaves the
			// user believing a change was saved that wasn't. Report it (the console alone never
			// reaches a backend), tell them, and re-read local state so the UI shows what actually
			// persisted rather than the optimistic value.
			const message = err instanceof Error ? err.message : String(err);
			console.error(`tracking: write failed for ${this.mediaId}`, err);
			reportClientError({
				message: `tracking write failed: ${message}`,
				stack: err instanceof Error ? err.stack : undefined,
				source: 'tracking',
				at: Date.now(),
				handled: true // already showing our own toast below
			});
			toast.error("Couldn't save that change", { description: 'Please try again.' });
			await this.load().catch(() => {});
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
			await recordEvents([
				...watches
					.filter((e) => e.watched)
					.map((e) => ({
						type: 'episode.unwatched' as const,
						entityId: this.mediaId,
						payload: { season: e.season, episode: e.episode }
					})),
				{ type: 'tracking.removed' as const, entityId: this.mediaId, payload: {} }
			]);
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

	/**
	 * Mark every **aired** episode of one season watched (bulk), then reconcile the show's status.
	 * Gated on {@link readyToMarkSeason}: the `disabled` bindings on the calling buttons are UX only,
	 * not the guarantee — this check is what actually stops an under-seeded write. A no-op (not an
	 * error) when not ready, same as the reconcile pass no-ops rather than guessing.
	 */
	markSeasonWatched(seasonNumber: number): Promise<void> {
		if (!this.readyToMarkSeason(seasonNumber)) return Promise.resolve();
		return this.#run(async () => {
			await this.#ensureTracked('watching');
			await this.#seedWatched(this.#markable(seasonNumber));
			await this.#reconcileStatus();
		});
	}

	/** Whether there's enough local data for {@link markSeasonWatched} to seed that season fully. */
	readyToMarkSeason(seasonNumber: number): boolean {
		return hasSufficientEpisodeData(
			this.#seasons,
			this.episodes,
			this.#inProduction,
			todayIso(),
			seasonNumber
		);
	}

	/**
	 * Mark the whole series watched: every **aired** episode watched, then the status reconciled from
	 * actual progress (see {@link readyToMarkSeries}). Bulk — one `episode.watched` per episode (the
	 * sync push cap bounds delivery). Enumerated from the season summaries, so it works the instant a
	 * title is added. Gated on {@link readyToMarkSeries}: the `disabled` bindings on the calling
	 * buttons are UX only, not the guarantee — this check is what actually stops an under-seeded
	 * write. A no-op (not an error) when not ready, same as the reconcile pass no-ops rather than
	 * guessing.
	 */
	markSeriesWatched(): Promise<void> {
		if (!this.readyToMarkSeries()) return Promise.resolve();
		return this.#run(async () => {
			await this.#ensureTracked('watching');
			await this.#seedWatched(this.#markable());
			await this.#reconcileStatus();
		});
	}

	/**
	 * Whether there's enough local season/episode data for {@link markSeriesWatched} to seed every
	 * aired episode without under-seeding an in-production season it can't yet enumerate. Reactive:
	 * tracks `#seasons` (via {@link updateSeasons}) and `episodes` (reloaded on sync pulls).
	 */
	readyToMarkSeries(): boolean {
		return hasSufficientEpisodeData(this.#seasons, this.episodes, this.#inProduction, todayIso());
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
		// One batch, not one transaction pair per episode — a long-running series is hundreds.
		await recordEvents(
			episodes.map(({ season, episode }) => ({
				type: 'episode.watched' as const,
				entityId: this.mediaId,
				payload: { season, episode }
			}))
		);
	}

	/** Move the status in line with episode progress (completion sequence) — see {@link reconcileStatus}. */
	#reconcileStatus(): Promise<void> {
		return reconcileStatus(this.mediaId, this.episodes, this.#inProduction);
	}
}
