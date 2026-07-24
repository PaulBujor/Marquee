/**
 * Pure decision helpers for the detail-page tracking controls. Kept free of any
 * IndexedDB/DOM dependency so the branching (add vs. change status, favorite
 * toggle direction) is unit-testable; the component composes these with
 * `recordEvent`. See `TrackingControls.svelte`.
 */
import type { EpisodeCoord, TrackingStatus } from '$lib/sync/events';

/** An episode coordinate; re-exported from the event model so there's one canonical definition. */
export type { EpisodeCoord };

/** The user-facing tracking state of a title, derived from its local tracking row. */
export type TrackingView =
	{ tracked: false } | { tracked: true; status: TrackingStatus; favorite: boolean };

/** Minimal shape of a local tracking row this module reads (see `ClientTracking`). */
interface TrackingRow {
	status: TrackingStatus;
	favorite: boolean;
	removed: boolean;
}

/** Collapse a local tracking row (or its absence) into a view. A removed row reads as untracked. */
export function toTrackingView(row: TrackingRow | undefined): TrackingView {
	if (!row || row.removed) return { tracked: false };
	return { tracked: true, status: row.status, favorite: row.favorite };
}

/**
 * Which event a status change emits: the first status on an untracked title is an
 * `added` (which asserts the row); any later change is a `status_changed`.
 */
export function statusEventType(view: TrackingView): 'tracking.added' | 'tracking.status_changed' {
	return view.tracked ? 'tracking.status_changed' : 'tracking.added';
}

/** The favorite value a toggle should write next — favoriting an untracked title implicitly adds it. */
export function nextFavorite(view: TrackingView): boolean {
	return !(view.tracked && view.favorite);
}

/** Minimal episode shape the watchability helpers read — coordinates + air date. */
export interface EpisodeAir {
	season: number;
	episode: number;
	/** Air date (`YYYY-MM-DD`), or null when unannounced / not yet scheduled. */
	airDate: string | null;
}

/**
 * The season number a provider uses for Specials. TMDB numbers them season 0; naming it
 * keeps the "skip Specials" rule from reading as a bare `>= 1`. Per-provider variance (other
 * catalogues may model Specials differently) is deferred to the Custom Media / provider epic.
 */
export const SPECIALS_SEASON = 0;

/** Whether a season is the Specials season, i.e. not part of the main 1..N progression. */
export function isSpecialsSeason(seasonNumber: number): boolean {
	return seasonNumber === SPECIALS_SEASON;
}

/** Stable key for an episode's watched-state, matching the client `episodeWatches` set. */
export function watchedKey(season: number, episode: number): string {
	return `${season}:${episode}`;
}

/** Today's date as `YYYY-MM-DD` (UTC). Air dates are date-only, so compared lexicographically. */
export function todayIso(now: number = Date.now()): string {
	return new Date(now).toISOString().slice(0, 10);
}

/**
 * Whether an episode has aired as of `today` (`YYYY-MM-DD`). A **null air date means unannounced /
 * not yet aired** — so it isn't watchable (and belongs on the upcoming calendar, not the past).
 */
export function isAired(ep: { airDate: string | null }, today: string): boolean {
	return ep.airDate !== null && ep.airDate <= today;
}

/** A show's episodes **excluding Specials** (season 0), sorted by (season, episode). */
export function mainEpisodes(episodes: EpisodeAir[]): EpisodeAir[] {
	return episodes
		.filter((e) => !isSpecialsSeason(e.season))
		.sort((a, b) => a.season - b.season || a.episode - b.episode);
}

/** Episodes that have aired as of `today` (excluding Specials), in order. */
export function airedEpisodes(episodes: EpisodeAir[], today: string): EpisodeAir[] {
	return mainEpisodes(episodes).filter((e) => isAired(e, today));
}

/**
 * The next episode to watch: the first aired episode (by season then episode) not in `watched`,
 * skipping Specials. Returns null when every aired episode is watched.
 */
export function nextEpisode(
	episodes: EpisodeAir[],
	watched: Set<string>,
	today: string
): EpisodeCoord | null {
	for (const e of airedEpisodes(episodes, today)) {
		if (!watched.has(watchedKey(e.season, e.episode)))
			return { season: e.season, episode: e.episode };
	}
	return null;
}

/** Whether every **aired** episode of a season is watched (false when it has no aired episodes). */
export function isSeasonFullyWatched(
	episodes: EpisodeAir[],
	seasonNumber: number,
	watched: Set<string>,
	today: string
): boolean {
	const aired = episodes.filter((e) => e.season === seasonNumber && isAired(e, today));
	if (aired.length === 0) return false;
	return aired.every((e) => watched.has(watchedKey(e.season, e.episode)));
}

/**
 * Whether a show is **still airing** — it's in production, or it has announced episodes not yet
 * aired (a future or unscheduled air date). Keeps a show you're caught up on but that isn't
 * finished in `watching` rather than auto-completing it, and covers the ended-then-revived case
 * (a status/`inProduction` flip on refresh brings it back).
 */
export function isStillAiring(
	episodes: EpisodeAir[],
	inProduction: boolean | null,
	today: string
): boolean {
	if (inProduction) return true;
	return episodes.some(
		(e) => !isSpecialsSeason(e.season) && (e.airDate === null || e.airDate > today)
	);
}

/**
 * Derive the status a show should move to from its episode-watch progress, or null when no
 * change is warranted. This is the completion sequence (MRQ-55): watching the last episode
 * completes it, unwatching one un-completes it, and the first watch starts it. It needs the
 * **aired episode count** (TMDB reference data, not in the event log), so it runs where that's
 * known and records a `status_changed`. An explicit `did_not_finish` is never auto-overridden;
 * `airedEpisodeCount === 0` (movies) derives nothing.
 *
 * `stillAiring` (there are announced episodes not yet aired) keeps a show you're **caught up on
 * but that hasn't finished airing** in `watching`, not `completed` — you're actively keeping up
 * with it, so it belongs in the Watching list. A show only completes once it's fully aired *and*
 * fully watched.
 */
export function reconciledStatus(
	current: TrackingStatus,
	watchedCount: number,
	airedEpisodeCount: number,
	stillAiring = false
): TrackingStatus | null {
	if (airedEpisodeCount === 0 || current === 'did_not_finish') return null;
	const caughtUp = watchedCount >= airedEpisodeCount;
	if (caughtUp && !stillAiring) return current === 'completed' ? null : 'completed';
	// In progress (or caught up on a still-airing show): back out a stale `completed`, and start
	// a `want_to_watch` title once its first episode is watched.
	if (current === 'completed') return 'watching';
	if (current === 'want_to_watch' && watchedCount > 0) return 'watching';
	return null;
}
