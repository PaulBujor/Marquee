import { describe, expect, it } from 'vitest';
import { deriveStatus, toTrackingView, type StatusDerivationContext } from './derive-status';
import { watchedKey, type DatedEpisode } from './actions';

const TODAY = '2026-07-24';

/** Build an episode record. */
function ep(season: number, episode: number, airDate: string | null): DatedEpisode {
	return { season, episode, airDate };
}

/** A finished, ten-episode single season, all aired. */
const finishedSeason: DatedEpisode[] = Array.from({ length: 10 }, (_, i) =>
	ep(1, i + 1, '2020-01-01')
);

const allWatched = (episodes: DatedEpisode[]): Set<string> =>
	new Set(episodes.map((e) => watchedKey(e.season, e.episode)));

describe('toTrackingView', () => {
	const movieContext: StatusDerivationContext = {
		type: 'movie',
		episodes: [],
		watched: new Set(),
		inProduction: null
	};

	it('treats a missing row as untracked', () => {
		expect(toTrackingView(undefined, movieContext)).toEqual({ tracked: false });
	});

	it('treats a removed (tombstoned) row as untracked', () => {
		expect(
			toTrackingView(
				{ status: 'completed', favorite: true, rating: 5, removed: true },
				movieContext
			)
		).toEqual({ tracked: false });
	});

	it('exposes status, favorite, and rating for a live row', () => {
		expect(
			toTrackingView(
				{ status: 'watching', favorite: true, rating: 4, removed: false },
				movieContext
			)
		).toEqual({
			tracked: true,
			status: 'watching',
			favorite: true,
			rating: 4
		});
	});

	it('carries a null rating through as unrated', () => {
		expect(
			toTrackingView(
				{ status: 'want_to_watch', favorite: false, rating: null, removed: false },
				movieContext
			)
		).toEqual({
			tracked: true,
			status: 'want_to_watch',
			favorite: false,
			rating: null
		});
	});

	it('derives a show status from the context rather than passing the row through as-is', () => {
		const showContext: StatusDerivationContext = {
			type: 'show',
			episodes: finishedSeason,
			watched: allWatched(finishedSeason),
			inProduction: false
		};
		expect(
			toTrackingView(
				{ status: 'want_to_watch', favorite: false, rating: null, removed: false },
				showContext
			)
		).toEqual({
			tracked: true,
			status: 'completed',
			favorite: false,
			rating: null
		});
	});
});

describe('deriveStatus — movies', () => {
	it('always returns the projected status unchanged, whatever it is', () => {
		for (const status of ['want_to_watch', 'watching', 'completed', 'did_not_finish'] as const) {
			expect(
				deriveStatus({
					type: 'movie',
					projectedStatus: status,
					episodes: [],
					watched: new Set(),
					inProduction: null,
					today: TODAY
				})
			).toBe(status);
		}
	});

	it('is unaffected even if episode/watched data is (nonsensically) present', () => {
		expect(
			deriveStatus({
				type: 'movie',
				projectedStatus: 'watching',
				episodes: finishedSeason,
				watched: allWatched(finishedSeason),
				inProduction: false,
				today: TODAY
			})
		).toBe('watching');
	});
});

describe('deriveStatus — insufficient data does not override', () => {
	it('returns the projected status when no episodes are known locally', () => {
		expect(
			deriveStatus({
				type: 'show',
				projectedStatus: 'want_to_watch',
				episodes: [],
				watched: new Set(),
				inProduction: false,
				today: TODAY
			})
		).toBe('want_to_watch');
	});

	it('returns the projected status when nothing has aired yet', () => {
		const unaired: DatedEpisode[] = [ep(1, 1, '2027-01-01')];
		expect(
			deriveStatus({
				type: 'show',
				projectedStatus: 'completed', // nonsensical intent, but nothing to reconcile against
				episodes: unaired,
				watched: new Set(),
				inProduction: null,
				today: TODAY
			})
		).toBe('completed');
	});
});

describe('deriveStatus — the reported bug: seeded before episode metadata synced', () => {
	it('a bulk mark against season summaries (no per-episode data yet) does not force completion', () => {
		// The seed step (episodesToMark, tested in actions.test.ts) can mark every episode of a
		// finished season from season summaries alone, before per-episode air dates have synced —
		// so `watched` already has all ten keys while `episodes` (this module's completeness input)
		// is still empty at that instant.
		const status = deriveStatus({
			type: 'show',
			projectedStatus: 'watching',
			episodes: [],
			watched: allWatched(finishedSeason),
			inProduction: false,
			today: TODAY
		});
		expect(status).toBe('watching'); // unchanged — correctly deferred, not guessed at
	});

	it('derives completed on the very next read once episode metadata has synced, with no further write', () => {
		// Same title, same watched set, moments later: the media channel has now populated the
		// per-episode air dates. No `status_changed` event was recorded in between — this is the
		// point of read-time derivation: the same watched set now resolves correctly because the
		// function re-evaluates from scratch, rather than replaying a decision cached from before
		// the data arrived.
		const status = deriveStatus({
			type: 'show',
			projectedStatus: 'watching', // still whatever was last projected — never got a status_changed
			episodes: finishedSeason,
			watched: allWatched(finishedSeason),
			inProduction: false,
			today: TODAY
		});
		expect(status).toBe('completed');
	});
});

describe('deriveStatus — season added after the show was marked complete', () => {
	it('demotes back to watching once the new season has an aired, unwatched episode', () => {
		const season1 = finishedSeason;
		const newSeasonAired: DatedEpisode[] = [...season1, ep(2, 1, '2020-06-01')];
		const status = deriveStatus({
			type: 'show',
			projectedStatus: 'completed', // set when only season 1 existed
			episodes: newSeasonAired,
			watched: allWatched(season1), // season 2 episode 1 not watched
			inProduction: true,
			today: TODAY
		});
		expect(status).toBe('watching');
	});

	it('resolves back to completed once the newly added season is also watched', () => {
		const season1 = finishedSeason;
		const withSeason2: DatedEpisode[] = [...season1, ep(2, 1, '2020-06-01')];
		const status = deriveStatus({
			type: 'show',
			projectedStatus: 'watching', // demoted by the previous case once season 2 appeared
			episodes: withSeason2,
			watched: allWatched(withSeason2), // now including season 2 episode 1
			inProduction: false,
			today: TODAY
		});
		expect(status).toBe('completed');
	});
});

describe('deriveStatus — caught up but still airing stays watching, not completed', () => {
	it('in_production true', () => {
		expect(
			deriveStatus({
				type: 'show',
				projectedStatus: 'watching',
				episodes: finishedSeason,
				watched: allWatched(finishedSeason),
				inProduction: true,
				today: TODAY
			})
		).toBe('watching');
	});

	it('a stale completed on a still-airing show is corrected back to watching on read', () => {
		expect(
			deriveStatus({
				type: 'show',
				projectedStatus: 'completed',
				episodes: finishedSeason,
				watched: allWatched(finishedSeason),
				inProduction: true,
				today: TODAY
			})
		).toBe('watching');
	});
});

describe('deriveStatus — explicit did_not_finish is never overridden', () => {
	it('stays did_not_finish even when every aired episode is watched', () => {
		expect(
			deriveStatus({
				type: 'show',
				projectedStatus: 'did_not_finish',
				episodes: finishedSeason,
				watched: allWatched(finishedSeason),
				inProduction: false,
				today: TODAY
			})
		).toBe('did_not_finish');
	});
});
