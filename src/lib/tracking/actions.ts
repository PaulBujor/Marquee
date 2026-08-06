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
	| { tracked: false }
	| { tracked: true; status: TrackingStatus; favorite: boolean; rating: number | null };

/** Minimal shape of a local tracking row this module reads (see `ClientTracking`). */
export interface TrackingRow {
	status: TrackingStatus;
	favorite: boolean;
	rating: number | null;
	removed: boolean;
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

/**
 * Whether a title in the given status is rateable — you can only rate something you've actually
 * watched, never a "want to watch". A movie is rateable once finished (completed / didn't finish);
 * a series also while you're watching it. Drives both the detail-page rating control and whether a
 * stored rating is surfaced elsewhere (e.g. the poster badge) — the rating itself is kept on the row
 * either way, so it returns if the title moves back to a rateable status.
 */
export function canRate(type: 'movie' | 'show', status: TrackingStatus): boolean {
	return type === 'show'
		? status !== 'want_to_watch'
		: status === 'completed' || status === 'did_not_finish';
}

/** What the watched-date helpers need about a title: its kind, its status, and the two clocks. */
export interface WatchedAtInput {
	type: 'movie' | 'show';
	status: TrackingStatus;
	/** Epoch ms the status last changed — when a `completed` title became completed. */
	statusUpdatedAt: number;
	/** Epoch ms the most recent episode was marked watched, or null (movies / nothing watched). */
	lastEpisodeWatchedAt: number | null;
}

/**
 * When a title was (last) watched, or null when there's nothing meaningful to show. Both clocks
 * are already carried by the materialized projections — the episode watch clock and the tracking
 * row's status clock — so this reads history the app has always recorded but never surfaced.
 *
 * These record **when the user marked it**, which is as close to a watch date as the event log
 * gets; back-dating a watch would need the date on the event itself.
 */
export function watchedAt(input: WatchedAtInput): number | null {
	if (input.type === 'show' && input.lastEpisodeWatchedAt !== null) {
		return input.lastEpisodeWatchedAt;
	}
	return input.status === 'completed' ? input.statusUpdatedAt : null;
}

/** How to label that date: a finished title was "Watched", one still in progress "Last watched". */
export function watchedAtLabel(input: WatchedAtInput): 'Watched' | 'Last watched' {
	return input.status === 'completed' ? 'Watched' : 'Last watched';
}

/** An episode coordinate with its air date — the input to the watchability helpers below. */
export interface DatedEpisode {
	season: number;
	episode: number;
	/** `YYYY-MM-DD`, or null. */
	airDate: string | null;
}

/**
 * The season number a provider uses for Specials. TMDB numbers them season 0; naming it
 * keeps the "skip Specials" rule from reading as a bare `>= 1`.
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
export function mainEpisodes(episodes: DatedEpisode[]): DatedEpisode[] {
	return episodes
		.filter((e) => !isSpecialsSeason(e.season))
		.sort((a, b) => a.season - b.season || a.episode - b.episode);
}

/** Episodes that have aired as of `today` (excluding Specials), in order. */
export function airedEpisodes(episodes: DatedEpisode[], today: string): DatedEpisode[] {
	return mainEpisodes(episodes).filter((e) => isAired(e, today));
}

/**
 * The next episode to watch: the first aired episode (by season then episode) not in `watched`,
 * skipping Specials. Returns null when every aired episode is watched.
 */
export function nextEpisode(
	episodes: DatedEpisode[],
	watched: Set<string>,
	today: string
): EpisodeCoord | null {
	for (const e of airedEpisodes(episodes, today)) {
		if (!watched.has(watchedKey(e.season, e.episode)))
			return { season: e.season, episode: e.episode };
	}
	return null;
}

/** Minimal season summary the detail page holds up-front (from TMDB detail), before per-episode sync. */
export interface SeasonSummary {
	seasonNumber: number;
	episodeCount: number;
	/** `YYYY-MM-DD` season air date, or null if unknown. */
	airDate: string | null;
}

/**
 * The episode coords a bulk "mark watched" should seed, derived from the season summaries the detail
 * page already has — so it works the instant a title is added, before the media channel syncs
 * per-episode air dates. Precision by source, per season:
 *
 * - If we already hold **per-episode** air dates for the season (`dated`), mark only its aired episodes.
 * - Else, for a **finished** show (`inProduction === false`) whose season has aired, mark the whole
 *   season by its `episodeCount` — every episode of a finished, aired season has aired.
 * - Else (still in production, or the season hasn't aired / has no data), mark nothing: we can't tell
 *   aired from unaired without per-episode dates, and must not seed a future episode as watched.
 *
 * Skips Specials (season 0). `seasonFilter` limits to one season ("mark season watched").
 */
export function episodesToMark(
	seasons: SeasonSummary[],
	dated: DatedEpisode[],
	inProduction: boolean | null,
	today: string,
	seasonFilter?: number
): EpisodeCoord[] {
	const out: EpisodeCoord[] = [];
	for (const s of seasons) {
		if (isSpecialsSeason(s.seasonNumber)) continue;
		if (seasonFilter !== undefined && s.seasonNumber !== seasonFilter) continue;
		const seasonDated = dated.filter((e) => e.season === s.seasonNumber);
		if (seasonDated.length > 0) {
			for (const e of seasonDated) {
				if (isAired(e, today)) out.push({ season: e.season, episode: e.episode });
			}
		} else if (!inProduction && s.airDate !== null && s.airDate <= today) {
			for (let episode = 1; episode <= s.episodeCount; episode++) {
				out.push({ season: s.seasonNumber, episode });
			}
		}
	}
	return out;
}

/** Whether every **aired** episode of a season is watched (false when it has no aired episodes). */
export function isSeasonFullyWatched(
	episodes: DatedEpisode[],
	seasonNumber: number,
	watched: Set<string>,
	today: string
): boolean {
	const aired = episodes.filter((e) => e.season === seasonNumber && isAired(e, today));
	if (aired.length === 0) return false;
	return aired.every((e) => watched.has(watchedKey(e.season, e.episode)));
}

/** Whether every **aired** episode across all seasons is watched (false when nothing has aired). */
export function isSeriesFullyWatched(
	episodes: DatedEpisode[],
	watched: Set<string>,
	today: string
): boolean {
	const aired = airedEpisodes(episodes, today);
	if (aired.length === 0) return false;
	return aired.every((e) => watched.has(watchedKey(e.season, e.episode)));
}

/**
 * Whether `episodesToMark` has enough local data to enumerate every aired episode accurately.
 * Mirrors its own per-season resolution: a season is only resolvable once its per-episode dates
 * are **fully** synced (`seasonDated.length >= episodeCount` — a partial per-episode sync can't be
 * trusted any more than none at all), or, absent that, once the show is known **finished**
 * (`inProduction === false`), where `episodeCount` itself resolves it. Still in production (`true`,
 * or unknown), an aired season without full per-episode coverage can't be enumerated. No seasons at
 * all (summaries not loaded) is never ready — an aired-but-unseen season can't be ruled out.
 * `seasonFilter` scopes the check to one season (readiness for "mark season watched").
 */
export function hasSufficientEpisodeData(
	seasons: SeasonSummary[],
	dated: DatedEpisode[],
	inProduction: boolean | null,
	today: string,
	seasonFilter?: number
): boolean {
	const seasonsToCheck = seasons.filter(
		(s) =>
			!isSpecialsSeason(s.seasonNumber) &&
			(seasonFilter === undefined || s.seasonNumber === seasonFilter)
	);
	if (seasonsToCheck.length === 0) return false;
	for (const s of seasonsToCheck) {
		if (s.airDate === null || s.airDate > today) continue;
		const seasonDated = dated.filter((e) => e.season === s.seasonNumber);
		if (seasonDated.length >= s.episodeCount) continue;
		if (inProduction !== true) continue;
		return false;
	}
	return true;
}

/**
 * Whether a show may still gain episodes — it's in production, or has announced episodes not yet
 * aired. Keeps a caught-up-but-unfinished show in `watching` instead of auto-completing it.
 */
export function isStillAiring(
	episodes: DatedEpisode[],
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
 * change is warranted. This is the completion sequence: watching the last episode
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
	if (current === 'completed') return 'watching';
	if (current === 'want_to_watch' && watchedCount > 0) return 'watching';
	return null;
}
