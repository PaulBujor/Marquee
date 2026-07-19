import { afterEach, describe, expect, it, vi } from 'vitest';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { load } from './+page.server';

type LoadFn = typeof load;
type LoadEvent = Parameters<LoadFn>[0];

/** The load's data shape (its inferred type is widened to `void | Data` by PageServerLoad). */
type SearchData = { q: string; results: unknown[]; failed: boolean };

/** Build a minimal event the load actually reads (locals.user, platform.env, url). */
function makeEvent(opts: {
	user?: unknown;
	q?: string | null;
	apiKey?: string | null;
	hasPlatform?: boolean;
}): LoadEvent {
	const { user = { id: 'u1' }, q = null, apiKey = 'key', hasPlatform = true } = opts;
	const url = new URL(`http://localhost/search${q === null ? '' : `?q=${encodeURIComponent(q)}`}`);
	const platform = hasPlatform
		? { env: apiKey === null ? {} : { TMDB_API_KEY: apiKey } }
		: undefined;
	return { locals: { user }, platform, url } as unknown as LoadEvent;
}

/** Run the load and return whatever it threw (redirect/error are thrown, not returned). */
async function thrownBy(run: () => unknown): Promise<{ status: number; location?: string }> {
	try {
		await run();
		throw new Error('expected the load to throw');
	} catch (err) {
		return err as { status: number; location?: string };
	}
}

function tmdbResponse(body: unknown, status = 200) {
	return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('search load', () => {
	it('redirects to /login when signed out', async () => {
		const err = await thrownBy(() => load(makeEvent({ user: null })));
		expect(isRedirect(err)).toBe(true);
		expect(err.status).toBe(303);
		expect(err.location).toBe('/login');
	});

	it('returns the empty state for a blank query without calling TMDB', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const result = await load(makeEvent({ q: '' }));
		expect(result).toEqual({ q: '', results: [], failed: false });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('errors 503 when the platform is unavailable', async () => {
		const err = await thrownBy(() => load(makeEvent({ q: 'inception', hasPlatform: false })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(503);
	});

	it('errors 503 when the API key is missing', async () => {
		const err = await thrownBy(() => load(makeEvent({ q: 'inception', apiKey: null })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(503);
	});

	it('returns normalized results on success', async () => {
		vi.stubGlobal(
			'fetch',
			tmdbResponse({
				results: [
					{
						id: 27205,
						media_type: 'movie',
						title: 'Inception',
						release_date: '2010-07-16',
						poster_path: '/i.jpg',
						overview: 'x'
					}
				]
			})
		);
		const result = (await load(makeEvent({ q: 'inception' }))) as unknown as SearchData;
		expect(result.q).toBe('inception');
		expect(result.failed).toBe(false);
		expect(result.results).toEqual([
			{
				tmdbId: 27205,
				type: 'movie',
				title: 'Inception',
				year: 2010,
				posterPath: '/i.jpg',
				overview: 'x'
			}
		]);
	});

	it('soft-fails (failed:true) when TMDB errors', async () => {
		vi.stubGlobal('fetch', tmdbResponse({}, 500));
		const result = await load(makeEvent({ q: 'inception' }));
		expect(result).toEqual({ q: 'inception', results: [], failed: true });
	});
});
