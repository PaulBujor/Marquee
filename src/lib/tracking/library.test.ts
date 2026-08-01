import { describe, expect, it } from 'vitest';
import {
	availableGenres,
	availableYears,
	continueWatching,
	filterAndSortLibrary,
	filterUpcoming,
	groupUpcomingByYear,
	showProgress,
	type LibraryItem,
	type UpcomingEntry
} from './library';

/** A season 1 with `count` already-aired episodes (dates in the past). */
function airedSeason(count: number): { season: number; episode: number; airDate: string | null }[] {
	return Array.from({ length: count }, (_, i) => ({
		season: 1,
		episode: i + 1,
		airDate: '2020-01-01'
	}));
}

function item(over: Partial<LibraryItem> = {}): LibraryItem {
	return {
		mediaId: over.mediaId ?? 'm',
		externalId: 'movie/1',
		status: 'want_to_watch',
		favorite: false,
		rating: null,
		addedAt: 0,
		watchedAt: null,
		type: 'movie',
		title: 'X',
		year: 2000,
		releaseDate: null,
		firstAirDate: null,
		posterPath: null,
		genres: [],
		inProduction: null,
		episodes: [],
		watched: new Set(),
		...over
	};
}

describe('showProgress', () => {
	it('is null for a movie', () => {
		expect(showProgress(item({ type: 'movie' }))).toBeNull();
	});

	it('computes watched/total and the next episode from aired episodes', () => {
		const p = showProgress(
			item({ type: 'show', episodes: airedSeason(4), watched: new Set(['1:1', '1:2']) })
		);
		expect(p).toEqual({ watched: 2, total: 4, fraction: 0.5, next: { season: 1, episode: 3 } });
	});

	it('counts only aired episodes toward total (a future episode is not "remaining")', () => {
		const p = showProgress(
			item({
				type: 'show',
				episodes: [
					{ season: 1, episode: 1, airDate: '2020-01-01' },
					{ season: 1, episode: 2, airDate: '2999-01-01' } // far-future → unaired
				],
				watched: new Set(['1:1'])
			})
		);
		expect(p).toEqual({ watched: 1, total: 1, fraction: 1, next: null });
	});
});

describe('continueWatching', () => {
	it('keeps only in-progress shows with a next episode', () => {
		const items = [
			item({ mediaId: 'movie', type: 'movie', status: 'watching' }), // movie — excluded
			item({
				mediaId: 'inprogress',
				type: 'show',
				status: 'watching',
				episodes: airedSeason(3),
				watched: new Set(['1:1'])
			}),
			item({
				mediaId: 'done',
				type: 'show',
				status: 'completed',
				episodes: airedSeason(2),
				watched: new Set(['1:1', '1:2'])
			})
		];
		expect(continueWatching(items).map((i) => i.mediaId)).toEqual(['inprogress']);
	});
});

describe('filterAndSortLibrary', () => {
	const items = [
		item({
			mediaId: 'a',
			title: 'Zed',
			status: 'watching',
			type: 'show',
			year: 2010,
			genres: ['Drama'],
			addedAt: 100
		}),
		item({
			mediaId: 'b',
			title: 'Alpha',
			status: 'want_to_watch',
			type: 'movie',
			year: 2020,
			genres: ['Action'],
			addedAt: 300
		}),
		item({
			mediaId: 'c',
			title: 'Mid',
			status: 'completed',
			favorite: true,
			type: 'movie',
			year: 2015,
			genres: ['Action', 'Drama'],
			addedAt: 200
		})
	];

	it('filters by tab (favorites spans statuses)', () => {
		expect(
			filterAndSortLibrary(items, {
				tab: 'watching',
				type: 'all',
				year: null,
				genre: null,
				release: 'all',
				sort: 'title'
			}).map((i) => i.mediaId)
		).toEqual(['a']);
		expect(
			filterAndSortLibrary(items, {
				tab: 'favorites',
				type: 'all',
				year: null,
				genre: null,
				release: 'all',
				sort: 'title'
			}).map((i) => i.mediaId)
		).toEqual(['c']);
	});

	it('filters by type, year, and genre', () => {
		expect(
			filterAndSortLibrary(items, {
				tab: 'want_to_watch',
				type: 'movie',
				year: null,
				genre: null,
				release: 'all',
				sort: 'title'
			}).map((i) => i.mediaId)
		).toEqual(['b']);
		expect(
			filterAndSortLibrary(items, {
				tab: 'completed',
				type: 'all',
				year: 2015,
				genre: 'Drama',
				release: 'all',
				sort: 'title'
			}).map((i) => i.mediaId)
		).toEqual(['c']);
	});

	it('sorts by title, release date, and date added', () => {
		// Sort directly over a set sharing a tab: give all three the same status.
		const same = [items[0], items[1], items[2]].map((i) => ({
			...i,
			status: 'completed' as const
		}));
		const f = {
			tab: 'completed' as const,
			type: 'all' as const,
			year: null,
			genre: null,
			release: 'all' as const
		};
		expect(filterAndSortLibrary(same, { ...f, sort: 'title' }).map((i) => i.title)).toEqual([
			'Alpha',
			'Mid',
			'Zed'
		]);
		expect(filterAndSortLibrary(same, { ...f, sort: 'date' }).map((i) => i.year)).toEqual([
			2020, 2015, 2010
		]);
		expect(filterAndSortLibrary(same, { ...f, sort: 'added' }).map((i) => i.addedAt)).toEqual([
			300, 200, 100
		]);
	});

	it('sorts by watched date, newest first, with never-watched titles last', () => {
		const f = {
			tab: 'completed' as const,
			type: 'all' as const,
			year: null,
			genre: null,
			release: 'all' as const,
			sort: 'watched' as const
		};
		const rows = [
			item({ mediaId: 'never', status: 'completed', watchedAt: null }),
			item({ mediaId: 'old', status: 'completed', watchedAt: 1_000 }),
			item({ mediaId: 'recent', status: 'completed', watchedAt: 9_000 }),
			item({ mediaId: 'never-too', status: 'completed', watchedAt: null })
		];
		expect(filterAndSortLibrary(rows, f).map((i) => i.mediaId)).toEqual([
			'recent',
			'old',
			'never',
			'never-too'
		]);
	});

	it('sorts by full release date, not just the year (movie releaseDate / show firstAirDate)', () => {
		const f = {
			tab: 'want_to_watch' as const,
			type: 'all' as const,
			year: null,
			genre: null,
			release: 'all' as const
		};
		const rows = [
			item({ mediaId: 'jan', title: 'Jan', year: 2026, releaseDate: '2026-01-10' }),
			item({ mediaId: 'dec', title: 'Dec', year: 2026, releaseDate: '2026-12-20' }),
			item({ mediaId: 'show', title: 'Show', type: 'show', year: 2026, firstAirDate: '2026-06-15' })
		];
		expect(filterAndSortLibrary(rows, { ...f, sort: 'date' }).map((i) => i.mediaId)).toEqual([
			'dec',
			'show',
			'jan'
		]);
	});

	it('sorts an undated title as furthest-future and a year-only title as end of year (date sort)', () => {
		const today = '2026-07-25';
		const f = {
			tab: 'want_to_watch' as const,
			type: 'all' as const,
			year: null,
			genre: null,
			release: 'all' as const,
			sort: 'date' as const
		};
		const rows = [
			item({ mediaId: 'exact', title: 'Exact', year: 2026, releaseDate: '2026-03-01' }),
			item({ mediaId: 'yearonly', title: 'YearOnly', year: 2026, releaseDate: null }), // → 2026-12-31
			item({ mediaId: 'undated', title: 'Undated', year: null, releaseDate: null }) // → furthest future
		];
		// Newest-first: undated (furthest future) → year-only (end of 2026) → the exact March date.
		expect(filterAndSortLibrary(rows, f, today).map((i) => i.mediaId)).toEqual([
			'undated',
			'yearonly',
			'exact'
		]);
	});

	it('filters by release status, counting undated / current-year-only titles as upcoming', () => {
		const today = '2026-07-25';
		const base = {
			tab: 'want_to_watch' as const,
			type: 'all' as const,
			year: null,
			genre: null,
			sort: 'title' as const
		};
		const rows = [
			item({ mediaId: 'past', title: 'Past', releaseDate: '2020-01-01' }),
			item({ mediaId: 'future', title: 'Future', releaseDate: '2027-01-01' }),
			item({ mediaId: 'thisyear', title: 'ThisYear', year: 2026, releaseDate: null }), // → 2026-12-31
			item({ mediaId: 'undated', title: 'Undated', year: null, releaseDate: null })
		];
		expect(
			filterAndSortLibrary(rows, { ...base, release: 'released' }, today).map((i) => i.mediaId)
		).toEqual(['past']);
		expect(
			filterAndSortLibrary(rows, { ...base, release: 'upcoming' }, today).map((i) => i.mediaId)
		).toEqual(['future', 'thisyear', 'undated']);
	});
});

describe('filterUpcoming', () => {
	const today = '2026-07-25';

	it('merges future episodes of watching shows with future releases of want-to-watch movies, date-sorted', () => {
		const items = [
			item({
				mediaId: 'show',
				type: 'show',
				status: 'watching',
				title: 'Show',
				episodes: [
					{ season: 1, episode: 1, airDate: '2026-01-01' }, // past → excluded
					{ season: 2, episode: 5, airDate: '2026-08-09' },
					{ season: 2, episode: 4, airDate: '2026-07-28' },
					{ season: 0, episode: 1, airDate: '2026-08-01' } // Special → excluded
				]
			}),
			item({
				mediaId: 'movie',
				type: 'movie',
				status: 'want_to_watch',
				title: 'Movie',
				releaseDate: '2026-08-02'
			})
		];
		expect(filterUpcoming(items, today).map((e) => [e.date, e.kind, e.title])).toEqual([
			['2026-07-28', 'episode', 'Show'],
			['2026-08-02', 'release', 'Movie'],
			['2026-08-09', 'episode', 'Show']
		]);
	});

	it('excludes non-watching shows and non-want-to-watch movies', () => {
		const items = [
			item({
				mediaId: 's',
				type: 'show',
				status: 'want_to_watch', // want-to-watch show → excluded (shows must be watching)
				episodes: [{ season: 1, episode: 1, airDate: '2999-01-01' }]
			}),
			item({
				mediaId: 'm',
				type: 'movie',
				status: 'completed', // completed movie → excluded
				releaseDate: '2999-01-01'
			})
		];
		expect(filterUpcoming(items, today)).toEqual([]);
	});
});

describe('groupUpcomingByYear', () => {
	const entry = (date: string, title: string): UpcomingEntry => ({
		date,
		mediaId: `${title}-${date}`,
		externalId: null,
		type: 'movie',
		title,
		posterPath: null,
		kind: 'release'
	});

	it('groups date-sorted entries into years, each with per-day runs, preserving order', () => {
		const entries = [
			entry('2026-07-28', 'A'),
			entry('2026-07-28', 'B'), // same day → same run
			entry('2026-12-31', 'C'),
			entry('2027-01-01', 'D'), // year boundary → new year
			entry('2027-01-01', 'E')
		];
		expect(
			groupUpcomingByYear(entries).map((y) => [
				y.year,
				y.days.map(([d, es]) => [d, es.map((e) => e.title)])
			])
		).toEqual([
			[
				'2026',
				[
					['2026-07-28', ['A', 'B']],
					['2026-12-31', ['C']]
				]
			],
			['2027', [['2027-01-01', ['D', 'E']]]]
		]);
	});

	it('returns an empty list for no entries', () => {
		expect(groupUpcomingByYear([])).toEqual([]);
	});
});

describe('available filter options', () => {
	const items = [
		item({ year: 2020, genres: ['Action', 'Drama'] }),
		item({ year: 2010, genres: ['Drama'] }),
		item({ year: 2020, genres: [] })
	];
	it('lists unique years newest-first', () => {
		expect(availableYears(items)).toEqual([2020, 2010]);
	});
	it('lists unique genres alphabetically', () => {
		expect(availableGenres(items)).toEqual(['Action', 'Drama']);
	});
});
