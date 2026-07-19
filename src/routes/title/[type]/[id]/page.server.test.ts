import { afterEach, describe, expect, it, vi } from 'vitest';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { load } from './+page.server';

type LoadFn = typeof load;
type LoadEvent = Parameters<LoadFn>[0];

/** The load's data shape (its inferred type is widened by PageServerLoad). */
type DetailData = { detail: { tmdbId: number; type: string; title: string } };

/** Build a minimal event the load actually reads (locals.user, params, platform.env). */
function makeEvent(opts: {
	user?: unknown;
	type?: string;
	id?: string;
	apiKey?: string | null;
	hasPlatform?: boolean;
}): LoadEvent {
	const {
		user = { id: 'u1' },
		type = 'movie',
		id = '27205',
		apiKey = 'key',
		hasPlatform = true
	} = opts;
	const platform = hasPlatform
		? { env: apiKey === null ? {} : { TMDB_API_KEY: apiKey } }
		: undefined;
	return { locals: { user }, params: { type, id }, platform } as unknown as LoadEvent;
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

describe('title detail load', () => {
	it('redirects to /login when signed out', async () => {
		const err = await thrownBy(() => load(makeEvent({ user: null })));
		expect(isRedirect(err)).toBe(true);
		expect(err.status).toBe(303);
		expect(err.location).toBe('/login');
	});

	it('404s on an unknown media type', async () => {
		const err = await thrownBy(() => load(makeEvent({ type: 'person' })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(404);
	});

	it('404s on a non-numeric id', async () => {
		const err = await thrownBy(() => load(makeEvent({ id: 'abc' })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(404);
	});

	it('errors 503 when the platform is unavailable', async () => {
		const err = await thrownBy(() => load(makeEvent({ hasPlatform: false })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(503);
	});

	it('errors 503 when the API key is missing', async () => {
		const err = await thrownBy(() => load(makeEvent({ apiKey: null })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(503);
	});

	it('returns the normalized detail on success', async () => {
		vi.stubGlobal(
			'fetch',
			tmdbResponse({ id: 27205, title: 'Inception', release_date: '2010-07-16' })
		);
		const result = (await load(makeEvent({}))) as unknown as DetailData;
		expect(result.detail).toMatchObject({ tmdbId: 27205, type: 'movie', title: 'Inception' });
	});

	it('maps a TMDB 404 to a 404 page', async () => {
		vi.stubGlobal('fetch', tmdbResponse({}, 404));
		const err = await thrownBy(() => load(makeEvent({ id: '999999999' })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(404);
	});

	it('maps other TMDB errors to a 502 page', async () => {
		vi.stubGlobal('fetch', tmdbResponse({}, 500));
		const err = await thrownBy(() => load(makeEvent({})));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(502);
	});
});
