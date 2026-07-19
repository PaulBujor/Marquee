import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTmdbClient, posterUrl, TmdbError } from './client';
import type { TmdbMultiSearchResponse } from './types';

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

describe('posterUrl', () => {
	it('builds a sized TMDB image URL', () => {
		expect(posterUrl('/poster.jpg')).toBe('https://image.tmdb.org/t/p/w342/poster.jpg');
		expect(posterUrl('/poster.jpg', 'w500')).toBe('https://image.tmdb.org/t/p/w500/poster.jpg');
	});

	it('returns null when there is no poster path', () => {
		expect(posterUrl(null)).toBeNull();
	});
});
