/**
 * Pure decision helpers for the detail-page tracking controls. Kept free of any
 * IndexedDB/DOM dependency so the branching (add vs. change status, favorite
 * toggle direction) is unit-testable; the component composes these with
 * `recordEvent`. See `TrackingControls.svelte`.
 */
import type { TrackingStatus } from '$lib/sync/events';

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

/** Minimal season shape these helpers read — a season number and how many episodes it has. */
export interface SeasonCounts {
	seasonNumber: number;
	episodeCount: number;
}

/** A single episode coordinate within a show. */
export interface EpisodeCoord {
	season: number;
	episode: number;
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

/** The episode coordinates of a single season, `1..episodeCount`. */
export function seasonEpisodes(season: SeasonCounts): EpisodeCoord[] {
	return Array.from({ length: season.episodeCount }, (_, i) => ({
		season: season.seasonNumber,
		episode: i + 1
	}));
}

/**
 * Every episode of a show, in order, **excluding Specials** (season 0 — not part of the
 * main progression). Used to seed a "mark whole series watched" bulk action.
 */
export function allEpisodes(seasons: SeasonCounts[]): EpisodeCoord[] {
	return seasons
		.filter((s) => !isSpecialsSeason(s.seasonNumber))
		.sort((a, b) => a.seasonNumber - b.seasonNumber)
		.flatMap(seasonEpisodes);
}

/** Whether an episode has aired, given the show's aired frontier. A null frontier ⇒ no cap. */
export function isAired(coord: EpisodeCoord, lastAired: EpisodeCoord | null): boolean {
	if (!lastAired) return true;
	return (
		coord.season < lastAired.season ||
		(coord.season === lastAired.season && coord.episode <= lastAired.episode)
	);
}

/** Episodes that have aired — {@link allEpisodes} capped at the aired frontier `lastAired`. */
export function airedEpisodes(
	seasons: SeasonCounts[],
	lastAired: EpisodeCoord | null
): EpisodeCoord[] {
	return allEpisodes(seasons).filter((c) => isAired(c, lastAired));
}

/**
 * The next episode to watch: the first aired episode (by season then episode) not in `watched`,
 * skipping Specials. Returns null when every aired episode is watched. `lastAired` caps it to
 * aired episodes so a caught-up show has no "next" (default null = no cap).
 */
export function nextEpisode(
	seasons: SeasonCounts[],
	watched: Set<string>,
	lastAired: EpisodeCoord | null = null
): EpisodeCoord | null {
	for (const coord of airedEpisodes(seasons, lastAired)) {
		if (!watched.has(watchedKey(coord.season, coord.episode))) return coord;
	}
	return null;
}

/** Whether every **aired** episode of a season is watched (false when it has no aired episodes). */
export function isSeasonFullyWatched(
	season: SeasonCounts,
	watched: Set<string>,
	lastAired: EpisodeCoord | null = null
): boolean {
	const aired = seasonEpisodes(season).filter((c) => isAired(c, lastAired));
	if (aired.length === 0) return false;
	return aired.every((c) => watched.has(watchedKey(c.season, c.episode)));
}

/**
 * Derive the status a show should move to from its episode-watch progress, or null when no
 * change is warranted. This is the completion sequence (MRQ-55): watching the last episode
 * completes it, unwatching one un-completes it, and the first watch starts it. It needs the
 * **total episode count** (TMDB reference data, not in the event log), so it runs where that's
 * known and records a `status_changed`. An explicit `did_not_finish` is never auto-overridden;
 * `totalEpisodes === 0` (movies) derives nothing.
 */
export function reconciledStatus(
	current: TrackingStatus,
	watchedCount: number,
	totalEpisodes: number
): TrackingStatus | null {
	if (totalEpisodes === 0 || current === 'did_not_finish') return null;
	const allWatched = watchedCount >= totalEpisodes;
	if (allWatched) return current === 'completed' ? null : 'completed';
	if (current === 'completed') return 'watching';
	if (current === 'want_to_watch' && watchedCount > 0) return 'watching';
	return null;
}
