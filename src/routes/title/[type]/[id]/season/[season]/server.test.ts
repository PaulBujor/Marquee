import { afterEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { GET } from './+server';

type GetFn = typeof GET;
type RequestEvent = Parameters<GetFn>[0];

/** Build a minimal event the handler reads (locals.user, params, platform.env). */
function makeEvent(opts: {
	user?: unknown;
	id?: string;
	season?: string;
	apiKey?: string | null;
	hasPlatform?: boolean;
}): RequestEvent {
	const {
		user = { id: 'u1' },
		id = '1396',
		season = '1',
		apiKey = 'key',
		hasPlatform = true
	} = opts;
	const platform = hasPlatform
		? { env: apiKey === null ? {} : { TMDB_API_KEY: apiKey } }
		: undefined;
	return {
		locals: { user },
		params: { type: 'show', id, season },
		platform
	} as unknown as RequestEvent;
}

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

describe('season endpoint', () => {
	it('401s when signed out', async () => {
		const err = await thrownBy(() => GET(makeEvent({ user: null })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(401);
	});

	it('404s on a non-numeric season', async () => {
		const err = await thrownBy(() => GET(makeEvent({ season: 'abc' })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(404);
	});

	it('503s when the API key is missing', async () => {
		const err = await thrownBy(() => GET(makeEvent({ apiKey: null })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(503);
	});

	it('returns the normalized season as JSON', async () => {
		vi.stubGlobal(
			'fetch',
			tmdbResponse({
				season_number: 1,
				name: 'Season 1',
				episodes: [{ episode_number: 1, name: 'Pilot', air_date: '2008-01-20', runtime: 58 }]
			})
		);
		const res = await GET(makeEvent({ season: '1' }));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ seasonNumber: 1, name: 'Season 1' });
		expect(body.episodes[0]).toMatchObject({ episodeNumber: 1, name: 'Pilot', runtime: 58 });
	});

	it('maps a TMDB 404 to a 404', async () => {
		vi.stubGlobal('fetch', tmdbResponse({}, 404));
		const err = await thrownBy(() => GET(makeEvent({ season: '99' })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(404);
	});

	it('maps other TMDB errors to a 502', async () => {
		vi.stubGlobal('fetch', tmdbResponse({}, 500));
		const err = await thrownBy(() => GET(makeEvent({})));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(502);
	});
});
