import { describe, expect, it } from 'vitest';
import {
	airedEpisodes,
	episodesToMark,
	isAired,
	isSeasonFullyWatched,
	isSpecialsSeason,
	isStillAiring,
	mainEpisodes,
	nextEpisode,
	nextFavorite,
	reconciledStatus,
	SPECIALS_SEASON,
	statusEventType,
	todayIso,
	toTrackingView,
	watchedKey,
	type DatedEpisode,
	type SeasonSummary
} from './actions';

const TODAY = '2026-07-24';

/** Build an episode record. */
function ep(season: number, episode: number, airDate: string | null): DatedEpisode {
	return { season, episode, airDate };
}

// A show spanning Specials + two seasons, with aired, future, and unannounced episodes.
const show: DatedEpisode[] = [
	ep(0, 1, '2020-01-01'), // Specials — excluded from the main progression
	ep(1, 1, '2026-01-01'), // aired
	ep(1, 2, '2026-02-01'), // aired
	ep(2, 1, '2026-07-01'), // aired
	ep(2, 2, '2026-12-01'), // future
	ep(2, 3, null) // unannounced
];

describe('toTrackingView', () => {
	it('treats a missing row as untracked', () => {
		expect(toTrackingView(undefined)).toEqual({ tracked: false });
	});

	it('treats a removed (tombstoned) row as untracked', () => {
		expect(toTrackingView({ status: 'completed', favorite: true, removed: true })).toEqual({
			tracked: false
		});
	});

	it('exposes status and favorite for a live row', () => {
		expect(toTrackingView({ status: 'watching', favorite: true, removed: false })).toEqual({
			tracked: true,
			status: 'watching',
			favorite: true
		});
	});
});

describe('statusEventType', () => {
	it('adds when the title is not yet tracked', () => {
		expect(statusEventType({ tracked: false })).toBe('tracking.added');
	});

	it('changes status when the title is already tracked', () => {
		expect(statusEventType({ tracked: true, status: 'want_to_watch', favorite: false })).toBe(
			'tracking.status_changed'
		);
	});
});

describe('nextFavorite', () => {
	it('favorites an untracked title (implicit add)', () => {
		expect(nextFavorite({ tracked: false })).toBe(true);
	});

	it('toggles off when already favorited', () => {
		expect(nextFavorite({ tracked: true, status: 'watching', favorite: true })).toBe(false);
	});

	it('toggles on when tracked but not favorited', () => {
		expect(nextFavorite({ tracked: true, status: 'watching', favorite: false })).toBe(true);
	});
});

describe('episode helpers', () => {
	it('builds a stable watched key', () => {
		expect(watchedKey(2, 5)).toBe('2:5');
	});

	it('identifies the Specials season by name, not a bare number', () => {
		expect(SPECIALS_SEASON).toBe(0);
		expect(isSpecialsSeason(0)).toBe(true);
		expect(isSpecialsSeason(1)).toBe(false);
	});

	it('mainEpisodes drops Specials and sorts by (season, episode)', () => {
		const scrambled = [ep(2, 1, null), ep(1, 2, null), ep(0, 1, null), ep(1, 1, null)];
		expect(mainEpisodes(scrambled)).toEqual([ep(1, 1, null), ep(1, 2, null), ep(2, 1, null)]);
	});

	it('todayIso formats an epoch as YYYY-MM-DD (UTC)', () => {
		expect(todayIso(Date.UTC(2026, 6, 24, 10, 0, 0))).toBe('2026-07-24');
	});
});

describe('isAired', () => {
	it('is true for an air date on or before today', () => {
		expect(isAired({ airDate: '2026-07-01' }, TODAY)).toBe(true);
		expect(isAired({ airDate: TODAY }, TODAY)).toBe(true);
	});

	it('is false for a future air date', () => {
		expect(isAired({ airDate: '2026-12-01' }, TODAY)).toBe(false);
	});

	it('treats a null air date as not yet aired', () => {
		expect(isAired({ airDate: null }, TODAY)).toBe(false);
	});
});

describe('airedEpisodes', () => {
	it('returns aired, non-Specials episodes in order (drops future + unannounced)', () => {
		expect(airedEpisodes(show, TODAY)).toEqual([
			ep(1, 1, '2026-01-01'),
			ep(1, 2, '2026-02-01'),
			ep(2, 1, '2026-07-01')
		]);
	});
});

describe('nextEpisode', () => {
	it('returns S1E1 when nothing is watched', () => {
		expect(nextEpisode(show, new Set(), TODAY)).toEqual({ season: 1, episode: 1 });
	});

	it('returns the first gap in order across seasons', () => {
		expect(nextEpisode(show, new Set(['1:1', '1:2']), TODAY)).toEqual({ season: 2, episode: 1 });
	});

	it('returns null once caught up to the aired frontier (ignores future/unannounced)', () => {
		expect(nextEpisode(show, new Set(['1:1', '1:2', '2:1']), TODAY)).toBeNull();
	});
});

describe('isSeasonFullyWatched', () => {
	it('is true when every aired episode of the season is watched (unaired ignored)', () => {
		// Season 2 has one aired episode (2:1); 2:2 is future, 2:3 unannounced.
		expect(isSeasonFullyWatched(show, 2, new Set(['2:1']), TODAY)).toBe(true);
	});

	it('is false when an aired episode is missing', () => {
		expect(isSeasonFullyWatched(show, 1, new Set(['1:1']), TODAY)).toBe(false);
	});

	it('is false for a season with no aired episodes', () => {
		const future = [ep(3, 1, '2027-01-01')];
		expect(isSeasonFullyWatched(future, 3, new Set(), TODAY)).toBe(false);
	});
});

describe('isStillAiring', () => {
	it('is true while in production', () => {
		expect(isStillAiring(show, true, TODAY)).toBe(true);
	});

	it('is true when announced-but-unaired episodes remain (even if not in production)', () => {
		// `show` has a future (2:2) and an unannounced (2:3) episode.
		expect(isStillAiring(show, false, TODAY)).toBe(true);
	});

	it('is false when every non-Specials episode has aired and it is not in production', () => {
		const done = [ep(1, 1, '2026-01-01'), ep(1, 2, '2026-02-01')];
		expect(isStillAiring(done, false, TODAY)).toBe(false);
	});
});

describe('reconciledStatus', () => {
	it('does not derive anything for something with no episodes (movies)', () => {
		expect(reconciledStatus('want_to_watch', 0, 0)).toBeNull();
	});

	it('completes when the last episode is watched', () => {
		expect(reconciledStatus('watching', 10, 10)).toBe('completed');
		expect(reconciledStatus('want_to_watch', 10, 10)).toBe('completed');
	});

	it('leaves an already-correct status alone', () => {
		expect(reconciledStatus('completed', 10, 10)).toBeNull();
		expect(reconciledStatus('watching', 5, 10)).toBeNull();
	});

	it('un-completes when an episode is unwatched', () => {
		expect(reconciledStatus('completed', 9, 10)).toBe('watching');
	});

	it('moves want-to-watch to watching once any episode is watched', () => {
		expect(reconciledStatus('want_to_watch', 1, 10)).toBe('watching');
		expect(reconciledStatus('want_to_watch', 0, 10)).toBeNull();
	});

	it('respects an explicit "did not finish" and never overrides it', () => {
		expect(reconciledStatus('did_not_finish', 10, 10)).toBeNull();
		expect(reconciledStatus('did_not_finish', 3, 10)).toBeNull();
	});

	it('keeps a caught-up but still-airing show in watching, not completed', () => {
		expect(reconciledStatus('watching', 10, 10, true)).toBeNull();
		expect(reconciledStatus('want_to_watch', 10, 10, true)).toBe('watching');
		expect(reconciledStatus('completed', 10, 10, true)).toBe('watching');
	});
});

describe('episodesToMark', () => {
	const TODAY = '2026-07-24';
	// A finished (not in production) show: S1 aired, S2 aired, plus Specials.
	const finishedSeasons: SeasonSummary[] = [
		{ seasonNumber: 0, episodeCount: 3, airDate: '2019-01-01' }, // Specials
		{ seasonNumber: 1, episodeCount: 2, airDate: '2020-01-01' },
		{ seasonNumber: 2, episodeCount: 4, airDate: '2021-01-01' }
	];

	it('marks every episode of a finished show by count when no per-episode data has synced', () => {
		expect(episodesToMark(finishedSeasons, [], false, TODAY)).toEqual([
			{ season: 1, episode: 1 },
			{ season: 1, episode: 2 },
			{ season: 2, episode: 1 },
			{ season: 2, episode: 2 },
			{ season: 2, episode: 3 },
			{ season: 2, episode: 4 }
		]);
	});

	it('limits to one season when a seasonFilter is given, still skipping Specials', () => {
		expect(episodesToMark(finishedSeasons, [], false, TODAY, 1)).toEqual([
			{ season: 1, episode: 1 },
			{ season: 1, episode: 2 }
		]);
		// Specials can never be targeted.
		expect(episodesToMark(finishedSeasons, [], false, TODAY, 0)).toEqual([]);
	});

	it('prefers per-episode air dates when present, marking only aired episodes', () => {
		const dated: DatedEpisode[] = [
			ep(2, 1, '2026-07-01'), // aired
			ep(2, 2, '2026-12-01'), // future
			ep(2, 3, null) // unannounced
		];
		// S1 has no dated rows → falls back to count (finished, aired). S2 uses the dated rows.
		expect(episodesToMark(finishedSeasons, dated, false, TODAY)).toEqual([
			{ season: 1, episode: 1 },
			{ season: 1, episode: 2 },
			{ season: 2, episode: 1 }
		]);
	});

	it('marks nothing by count for an in-production show (can not tell aired from unaired offline)', () => {
		const airing: SeasonSummary[] = [{ seasonNumber: 1, episodeCount: 8, airDate: '2026-06-01' }];
		expect(episodesToMark(airing, [], true, TODAY)).toEqual([]);
		// but precise per-episode data still works for an airing show
		const dated: DatedEpisode[] = [ep(1, 1, '2026-06-01'), ep(1, 2, '2026-12-01')];
		expect(episodesToMark(airing, dated, true, TODAY)).toEqual([{ season: 1, episode: 1 }]);
	});

	it('skips a season that has not aired yet (future or unknown season air date)', () => {
		const seasons: SeasonSummary[] = [
			{ seasonNumber: 1, episodeCount: 2, airDate: '2999-01-01' }, // future
			{ seasonNumber: 2, episodeCount: 2, airDate: null } // unknown
		];
		expect(episodesToMark(seasons, [], false, TODAY)).toEqual([]);
	});
});
