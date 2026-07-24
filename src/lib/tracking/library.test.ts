import { describe, expect, it } from 'vitest';
import {
	availableGenres,
	availableYears,
	continueWatching,
	filterAndSortLibrary,
	showProgress,
	type LibraryItem
} from './library';

function item(over: Partial<LibraryItem> = {}): LibraryItem {
	return {
		mediaId: over.mediaId ?? 'm',
		externalId: 'movie/1',
		status: 'want_to_watch',
		favorite: false,
		rating: null,
		addedAt: 0,
		type: 'movie',
		title: 'X',
		year: 2000,
		posterPath: null,
		genres: [],
		seasons: null,
		lastAired: null,
		watched: new Set(),
		...over
	};
}

describe('showProgress', () => {
	it('is null for a movie', () => {
		expect(showProgress(item({ type: 'movie' }))).toBeNull();
	});

	it('computes watched/total and the next episode for a show', () => {
		const p = showProgress(
			item({
				type: 'show',
				seasons: [{ seasonNumber: 1, episodeCount: 4 }],
				watched: new Set(['1:1', '1:2'])
			})
		);
		expect(p).toEqual({ watched: 2, total: 4, fraction: 0.5, next: { season: 1, episode: 3 } });
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
				seasons: [{ seasonNumber: 1, episodeCount: 3 }],
				watched: new Set(['1:1'])
			}),
			item({
				mediaId: 'done',
				type: 'show',
				status: 'completed',
				seasons: [{ seasonNumber: 1, episodeCount: 2 }],
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
				sort: 'title'
			}).map((i) => i.mediaId)
		).toEqual(['a']);
		expect(
			filterAndSortLibrary(items, {
				tab: 'favorites',
				type: 'all',
				year: null,
				genre: null,
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
				sort: 'title'
			}).map((i) => i.mediaId)
		).toEqual(['b']);
		expect(
			filterAndSortLibrary(items, {
				tab: 'completed',
				type: 'all',
				year: 2015,
				genre: 'Drama',
				sort: 'title'
			}).map((i) => i.mediaId)
		).toEqual(['c']);
	});

	it('sorts by title, release year, and date added', () => {
		const all = { tab: 'favorites' as const, type: 'all' as const, year: null, genre: null };
		// use a tab that includes several: switch to a filter that returns a,b,c — use type all + a status? favorites only has c.
		const three = [items[0], items[1], items[2]];
		expect(
			filterAndSortLibrary(three, { ...all, sort: 'title', tab: 'want_to_watch' }).length
		).toBe(1); // sanity
		// Sort directly over a set sharing a tab: give all three the same status.
		const same = three.map((i) => ({ ...i, status: 'completed' as const }));
		const f = { tab: 'completed' as const, type: 'all' as const, year: null, genre: null };
		expect(filterAndSortLibrary(same, { ...f, sort: 'title' }).map((i) => i.title)).toEqual([
			'Alpha',
			'Mid',
			'Zed'
		]);
		expect(filterAndSortLibrary(same, { ...f, sort: 'year' }).map((i) => i.year)).toEqual([
			2020, 2015, 2010
		]);
		expect(filterAndSortLibrary(same, { ...f, sort: 'added' }).map((i) => i.addedAt)).toEqual([
			300, 200, 100
		]);
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
