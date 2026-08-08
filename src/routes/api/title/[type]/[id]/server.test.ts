import { afterEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { GET } from './+server';

type Handler = typeof GET;
type RequestEvent = Parameters<Handler>[0];

/** Build a minimal event the handler reads (locals.user, params, platform.env, url). */
function makeEvent(opts: {
	user?: unknown;
	type?: string;
	id?: string;
	apiKey?: string | null;
	hasPlatform?: boolean;
	season?: string | null;
}): RequestEvent {
	const {
		user = { id: 'u1' },
		type = 'movie',
		id = '27205',
		apiKey = 'key',
		hasPlatform = true,
		season = null
	} = opts;
	const platform = hasPlatform
		? { env: apiKey === null ? {} : { TMDB_API_KEY: apiKey } }
		: undefined;
	const url = new URL(
		`http://localhost/api/title/${type}/${id}${season === null ? '' : `?season=${season}`}`
	);
	return { locals: { user }, params: { type, id }, platform, url } as unknown as RequestEvent;
}

const SHOW_WITH_SEASONS = {
	id: 1396,
	name: 'Breaking Bad',
	first_air_date: '2008-01-20',
	seasons: [
		{ season_number: 0, name: 'Specials', episode_count: 8 },
		{ season_number: 1, name: 'Season 1', episode_count: 7 }
	]
};

/** Stub fetch to answer the detail call, then each subsequent season call. */
function stubShowFetch() {
	const fetchSpy = vi.fn(async (input: URL | string) => {
		const path = new URL(String(input)).pathname;
		if (/\/season\/\d+$/.test(path)) {
			const seasonNumber = Number(path.split('/').pop());
			return new Response(
				JSON.stringify({
					season_number: seasonNumber,
					name: `Season ${seasonNumber}`,
					overview: `Synopsis for season ${seasonNumber}.`,
					episodes: []
				})
			);
		}
		return new Response(JSON.stringify(SHOW_WITH_SEASONS));
	});
	vi.stubGlobal('fetch', fetchSpy);
	return fetchSpy;
}

/** Run the handler and return whatever it threw (errors are thrown, not returned). */
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

describe('GET /api/title/[type]/[id]', () => {
	it('401s when signed out', async () => {
		const err = await thrownBy(() => GET(makeEvent({ user: null })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(401);
	});

	it('404s on an unknown media type', async () => {
		const err = await thrownBy(() => GET(makeEvent({ type: 'person' })));
		expect(err.status).toBe(404);
	});

	it('404s on a non-numeric id', async () => {
		const err = await thrownBy(() => GET(makeEvent({ id: 'abc' })));
		expect(err.status).toBe(404);
	});

	it('errors 503 when the platform is unavailable', async () => {
		const err = await thrownBy(() => GET(makeEvent({ hasPlatform: false })));
		expect(err.status).toBe(503);
	});

	it('errors 503 when the API key is missing', async () => {
		const err = await thrownBy(() => GET(makeEvent({ apiKey: null })));
		expect(err.status).toBe(503);
	});

	it('returns the normalized detail on success', async () => {
		vi.stubGlobal(
			'fetch',
			tmdbResponse({ id: 27205, title: 'Inception', release_date: '2010-07-16' })
		);
		const res = await GET(makeEvent({}));
		const body = (await res.json()) as { detail: { tmdbId: number; type: string; title: string } };
		expect(body.detail).toMatchObject({ tmdbId: 27205, type: 'movie', title: 'Inception' });
	});

	it('maps a TMDB 404 to a 404', async () => {
		vi.stubGlobal('fetch', tmdbResponse({}, 404));
		const err = await thrownBy(() => GET(makeEvent({ id: '999999999' })));
		expect(err.status).toBe(404);
	});

	it('maps other TMDB errors to a 502', async () => {
		vi.stubGlobal('fetch', tmdbResponse({}, 500));
		const err = await thrownBy(() => GET(makeEvent({})));
		expect(err.status).toBe(502);
	});

	it('returns null season for movies', async () => {
		vi.stubGlobal('fetch', tmdbResponse({ id: 1, title: 'Inception' }));
		const res = await GET(makeEvent({}));
		const body = (await res.json()) as { season: unknown };
		expect(body.season).toBeNull();
	});

	it('embeds the season description the detail page renders under the selector', async () => {
		stubShowFetch();
		const res = await GET(makeEvent({ type: 'show', id: '1396' }));
		const body = (await res.json()) as { season: { overview: string } };
		expect(body.season.overview).toBe('Synopsis for season 1.');
	});

	it('embeds the first non-Specials season by default for shows', async () => {
		stubShowFetch();
		const res = await GET(makeEvent({ type: 'show', id: '1396' }));
		const body = (await res.json()) as { season: { seasonNumber: number } };
		expect(body.season.seasonNumber).toBe(1);
	});

	it('embeds the requested ?season=N for shows', async () => {
		stubShowFetch();
		const res = await GET(makeEvent({ type: 'show', id: '1396', season: '0' }));
		const body = (await res.json()) as { season: { seasonNumber: number } };
		expect(body.season.seasonNumber).toBe(0);
	});

	it('falls back to the default season when ?season=N is not a real season', async () => {
		stubShowFetch();
		const res = await GET(makeEvent({ type: 'show', id: '1396', season: '99' }));
		const body = (await res.json()) as { season: { seasonNumber: number } };
		expect(body.season.seasonNumber).toBe(1);
	});
});
