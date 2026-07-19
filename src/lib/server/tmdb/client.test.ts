import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTmdbClient, TmdbError } from './client';
import type {
	TmdbMovieDetailsResponse,
	TmdbMultiSearchResponse,
	TmdbTvDetailsResponse
} from './types';

/** A representative `/search/multi` payload: a movie, a show, and a person to be filtered out. */
const SAMPLE: TmdbMultiSearchResponse = {
	page: 1,
	total_pages: 1,
	total_results: 3,
	results: [
		{
			id: 27205,
			media_type: 'movie',
			title: 'Inception',
			release_date: '2010-07-16',
			poster_path: '/inception.jpg',
			overview: 'A thief who steals corporate secrets.'
		},
		{
			id: 1396,
			media_type: 'tv',
			name: 'Breaking Bad',
			first_air_date: '2008-01-20',
			poster_path: null,
			overview: 'A chemistry teacher turned meth cook.'
		},
		{
			id: 500,
			media_type: 'person',
			name: 'Tom Cruise'
		}
	]
};

function mockFetch(response: unknown, init: { ok?: boolean; status?: number } = {}) {
	const spy = vi.fn(
		async () =>
			new Response(JSON.stringify(response), {
				status: init.status ?? (init.ok === false ? 500 : 200)
			})
	);
	vi.stubGlobal('fetch', spy);
	return spy;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('createTmdbClient.search', () => {
	it('normalizes movies and shows and drops people', async () => {
		mockFetch(SAMPLE);
		const results = await createTmdbClient('key').search('anything');

		expect(results).toEqual([
			{
				tmdbId: 27205,
				type: 'movie',
				title: 'Inception',
				year: 2010,
				posterPath: '/inception.jpg',
				overview: 'A thief who steals corporate secrets.'
			},
			{
				tmdbId: 1396,
				type: 'show',
				title: 'Breaking Bad',
				year: 2008,
				posterPath: null,
				overview: 'A chemistry teacher turned meth cook.'
			}
		]);
	});

	it('sends the api key, query, and adult filter on the request URL', async () => {
		const spy = mockFetch(SAMPLE);
		await createTmdbClient('secret-key').search('the matrix');

		const [firstArg] = spy.mock.calls[0] as unknown as [URL | string];
		const url = new URL(String(firstArg));
		expect(url.origin + url.pathname).toBe('https://api.themoviedb.org/3/search/multi');
		expect(url.searchParams.get('api_key')).toBe('secret-key');
		expect(url.searchParams.get('query')).toBe('the matrix');
		expect(url.searchParams.get('include_adult')).toBe('false');
	});

	it('trims the query and skips the network call when it is blank', async () => {
		const spy = mockFetch(SAMPLE);
		expect(await createTmdbClient('key').search('   ')).toEqual([]);
		expect(spy).not.toHaveBeenCalled();
	});

	it('leaves year null when TMDB has no date', async () => {
		mockFetch({
			page: 1,
			total_pages: 1,
			total_results: 1,
			results: [{ id: 1, media_type: 'movie', title: 'Untitled' }]
		});
		const [result] = await createTmdbClient('key').search('x');
		expect(result.year).toBeNull();
	});

	it('throws TmdbError on a non-2xx response', async () => {
		mockFetch({}, { status: 401 });
		await expect(createTmdbClient('bad').search('x')).rejects.toMatchObject({
			name: 'TmdbError',
			status: 401
		});
	});

	it('wraps a network failure as a 502 TmdbError', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('ECONNRESET');
			})
		);
		await expect(createTmdbClient('key').search('x')).rejects.toBeInstanceOf(TmdbError);
	});
});

/** A representative `/movie/{id}?append_to_response=credits,images,videos` payload. */
const MOVIE_DETAILS: TmdbMovieDetailsResponse = {
	id: 27205,
	title: 'Inception',
	release_date: '2010-07-16',
	overview: 'A thief who steals corporate secrets.',
	poster_path: '/inception.jpg',
	backdrop_path: '/inception-backdrop.jpg',
	vote_average: 8.4,
	vote_count: 34000,
	runtime: 148,
	genres: [
		{ id: 28, name: 'Action' },
		{ id: 878, name: 'Science Fiction' }
	],
	credits: {
		cast: [
			{ id: 1, name: 'Leonardo DiCaprio', character: 'Cobb', profile_path: '/leo.jpg', order: 0 },
			{ id: 2, name: 'Elliot Page', character: 'Ariadne', profile_path: null, order: 1 }
		]
	},
	images: { backdrops: [{ file_path: '/b1.jpg' }], posters: [{ file_path: '/p1.jpg' }] },
	videos: {
		results: [
			{ key: 'teaser1', name: 'Teaser', site: 'YouTube', type: 'Teaser' },
			{ key: 'yt-trailer', name: 'Official Trailer', site: 'YouTube', type: 'Trailer' }
		]
	}
};

/** A representative `/tv/{id}?append_to_response=...` payload. */
const TV_DETAILS: TmdbTvDetailsResponse = {
	id: 1396,
	name: 'Breaking Bad',
	first_air_date: '2008-01-20',
	overview: 'A chemistry teacher turned meth cook.',
	poster_path: '/bb.jpg',
	backdrop_path: '/bb-backdrop.jpg',
	vote_average: 8.9,
	vote_count: 12000,
	episode_run_time: [47, 45],
	genres: [{ id: 18, name: 'Drama' }],
	credits: {
		cast: [{ id: 3, name: 'Bryan Cranston', character: 'Walter White', profile_path: '/bc.jpg' }]
	},
	videos: {
		results: [{ key: 'bb-trailer', name: 'Trailer', site: 'YouTube', type: 'Trailer' }]
	}
};

describe('createTmdbClient.getDetails', () => {
	it('normalizes a movie detail', async () => {
		mockFetch(MOVIE_DETAILS);
		const detail = await createTmdbClient('key').getDetails('movie', 27205);

		expect(detail).toEqual({
			tmdbId: 27205,
			type: 'movie',
			title: 'Inception',
			year: 2010,
			overview: 'A thief who steals corporate secrets.',
			posterPath: '/inception.jpg',
			backdropPath: '/inception-backdrop.jpg',
			rating: 8.4,
			voteCount: 34000,
			runtime: 148,
			genres: ['Action', 'Science Fiction'],
			cast: [
				{ id: 1, name: 'Leonardo DiCaprio', character: 'Cobb', profilePath: '/leo.jpg' },
				{ id: 2, name: 'Elliot Page', character: 'Ariadne', profilePath: null }
			],
			trailer: { key: 'yt-trailer', name: 'Official Trailer' }
		});
	});

	it('normalizes a show detail (name/first_air_date/episode_run_time)', async () => {
		mockFetch(TV_DETAILS);
		const detail = await createTmdbClient('key').getDetails('show', 1396);

		expect(detail).toMatchObject({
			tmdbId: 1396,
			type: 'show',
			title: 'Breaking Bad',
			year: 2008,
			runtime: 47,
			genres: ['Drama'],
			trailer: { key: 'bb-trailer', name: 'Trailer' }
		});
		expect(detail.cast).toEqual([
			{ id: 3, name: 'Bryan Cranston', character: 'Walter White', profilePath: '/bc.jpg' }
		]);
	});

	it('requests the movie path with the append_to_response param', async () => {
		const spy = mockFetch(MOVIE_DETAILS);
		await createTmdbClient('secret-key').getDetails('movie', 27205);

		const [firstArg] = spy.mock.calls[0] as unknown as [URL | string];
		const url = new URL(String(firstArg));
		expect(url.origin + url.pathname).toBe('https://api.themoviedb.org/3/movie/27205');
		expect(url.searchParams.get('api_key')).toBe('secret-key');
		expect(url.searchParams.get('append_to_response')).toBe('credits,images,videos');
	});

	it('requests the tv path for shows', async () => {
		const spy = mockFetch(TV_DETAILS);
		await createTmdbClient('key').getDetails('show', 1396);

		const [firstArg] = spy.mock.calls[0] as unknown as [URL | string];
		const url = new URL(String(firstArg));
		expect(url.origin + url.pathname).toBe('https://api.themoviedb.org/3/tv/1396');
	});

	it('picks the first YouTube Trailer, ignoring non-YouTube and non-Trailer videos', async () => {
		mockFetch({
			...MOVIE_DETAILS,
			videos: {
				results: [
					{ key: 'vimeo1', name: 'Vimeo Trailer', site: 'Vimeo', type: 'Trailer' },
					{ key: 'clip1', name: 'Clip', site: 'YouTube', type: 'Clip' },
					{ key: 'yt-first', name: 'First YT Trailer', site: 'YouTube', type: 'Trailer' },
					{ key: 'yt-second', name: 'Second YT Trailer', site: 'YouTube', type: 'Trailer' }
				]
			}
		});
		const detail = await createTmdbClient('key').getDetails('movie', 1);
		expect(detail.trailer).toEqual({ key: 'yt-first', name: 'First YT Trailer' });
	});

	it('leaves trailer null when there is no YouTube trailer', async () => {
		mockFetch({
			...MOVIE_DETAILS,
			videos: { results: [{ key: 'x', name: 'Teaser', site: 'YouTube', type: 'Teaser' }] }
		});
		const detail = await createTmdbClient('key').getDetails('movie', 1);
		expect(detail.trailer).toBeNull();
	});

	it('caps cast at the top 10', async () => {
		const cast = Array.from({ length: 25 }, (_, i) => ({
			id: i,
			name: `Actor ${i}`,
			character: `Role ${i}`,
			profile_path: null,
			order: i
		}));
		mockFetch({ ...MOVIE_DETAILS, credits: { cast } });
		const detail = await createTmdbClient('key').getDetails('movie', 1);
		expect(detail.cast).toHaveLength(10);
		expect(detail.cast[0].name).toBe('Actor 0');
		expect(detail.cast[9].name).toBe('Actor 9');
	});

	it('handles missing optional fields gracefully', async () => {
		mockFetch({ id: 1, title: 'Bare' });
		const detail = await createTmdbClient('key').getDetails('movie', 1);
		expect(detail).toEqual({
			tmdbId: 1,
			type: 'movie',
			title: 'Bare',
			year: null,
			overview: '',
			posterPath: null,
			backdropPath: null,
			rating: null,
			voteCount: 0,
			runtime: null,
			genres: [],
			cast: [],
			trailer: null
		});
	});

	it('treats a zero vote_average as unrated (null)', async () => {
		mockFetch({ ...MOVIE_DETAILS, vote_average: 0, vote_count: 0 });
		const detail = await createTmdbClient('key').getDetails('movie', 1);
		expect(detail.rating).toBeNull();
	});

	it('throws TmdbError on a non-2xx response', async () => {
		mockFetch({}, { status: 404 });
		await expect(createTmdbClient('key').getDetails('movie', 999)).rejects.toMatchObject({
			name: 'TmdbError',
			status: 404
		});
	});
});
