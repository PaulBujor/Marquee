import { afterEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { GET } from './+server';

type Handler = typeof GET;
type Event = Parameters<Handler>[0];

/** Build a minimal event the handler actually reads (locals.user, platform.env, url). */
function makeEvent(opts: {
	user?: unknown;
	q?: string | null;
	apiKey?: string | null;
	hasPlatform?: boolean;
}): Event {
	const { user = { id: 'u1' }, q = null, apiKey = 'key', hasPlatform = true } = opts;
	const url = new URL(
		`http://localhost/api/search${q === null ? '' : `?q=${encodeURIComponent(q)}`}`
	);
	const platform = hasPlatform
		? { env: apiKey === null ? {} : { TMDB_API_KEY: apiKey } }
		: undefined;
	return { locals: { user }, platform, url } as unknown as Event;
}

/** Run the handler and return whatever it threw (error() is thrown, not returned). */
async function thrownBy(run: () => unknown): Promise<{ status: number }> {
	try {
		await run();
		throw new Error('expected the handler to throw');
	} catch (err) {
		return err as { status: number };
	}
}

function tmdbResponse(body: unknown, status = 200) {
	return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('GET /api/search', () => {
	it('401s when signed out', async () => {
		const err = await thrownBy(() => GET(makeEvent({ user: null })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(401);
	});

	it('returns the empty state for a blank query without calling TMDB', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const res = await GET(makeEvent({ q: '' }));
		expect(await res.json()).toEqual({ results: [], degraded: false });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('errors 503 when the platform is unavailable', async () => {
		const err = await thrownBy(() => GET(makeEvent({ q: 'inception', hasPlatform: false })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(503);
	});

	it('errors 503 when the API key is missing', async () => {
		const err = await thrownBy(() => GET(makeEvent({ q: 'inception', apiKey: null })));
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
		const res = await GET(makeEvent({ q: 'inception' }));
		const data = (await res.json()) as { results: unknown[]; degraded: boolean };
		expect(data.degraded).toBe(false);
		expect(data.results).toEqual([
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

	it('degrades (degraded:true) when TMDB errors; no shared-library results without a db', async () => {
		vi.stubGlobal('fetch', tmdbResponse({}, 500));
		// makeEvent supplies no `locals.db`, so the shared-library fallback is skipped → empty results.
		const res = await GET(makeEvent({ q: 'inception' }));
		expect(await res.json()).toEqual({ results: [], degraded: true });
	});
});
