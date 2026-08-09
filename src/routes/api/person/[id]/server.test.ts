import { afterEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import type { PersonCreditsPage } from '$lib/server/tmdb';
import { GET } from './+server';

type Handler = typeof GET;
type Event = Parameters<Handler>[0];

/** Build a minimal event the handler actually reads (locals.user, params.id, platform.env, url). */
function makeEvent(opts: {
	user?: unknown;
	id?: string;
	page?: string | null;
	apiKey?: string | null;
	hasPlatform?: boolean;
}): Event {
	const { user = { id: 'u1' }, id = '287', page = null, apiKey = 'key', hasPlatform = true } = opts;
	const url = new URL(`http://localhost/api/person/${id}${page === null ? '' : `?page=${page}`}`);
	const platform = hasPlatform
		? { env: apiKey === null ? {} : { TMDB_API_KEY: apiKey } }
		: undefined;
	return { locals: { user }, params: { id }, platform, url } as unknown as Event;
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

/** `n` released movie credits, dated far enough in the past to never drift into "upcoming". */
function pastMovies(n: number) {
	return Array.from({ length: n }, (_, i) => ({
		id: 1000 + i,
		media_type: 'movie',
		title: `Film ${i}`,
		// Descending dates, so the normalized newest-first order matches this array order.
		release_date: `19${String(99 - i).padStart(2, '0')}-01-01`,
		character: 'Someone'
	}));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('GET /api/person/[id]', () => {
	it('401s when signed out', async () => {
		const err = await thrownBy(() => GET(makeEvent({ user: null })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(401);
	});

	it('404s on a non-numeric id', async () => {
		const err = await thrownBy(() => GET(makeEvent({ id: 'abc' })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(404);
	});

	it('404s on a non-positive id', async () => {
		const err = await thrownBy(() => GET(makeEvent({ id: '0' })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(404);
	});

	it('errors 503 when the platform is unavailable', async () => {
		const err = await thrownBy(() => GET(makeEvent({ hasPlatform: false })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(503);
	});

	it('errors 503 when the API key is missing', async () => {
		const err = await thrownBy(() => GET(makeEvent({ apiKey: null })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(503);
	});

	it('returns the normalized person and first page of credits', async () => {
		vi.stubGlobal(
			'fetch',
			tmdbResponse({
				id: 287,
				name: 'Brad Pitt',
				biography: 'An actor.',
				birthday: '1963-12-18',
				place_of_birth: 'Shawnee, Oklahoma, USA',
				known_for_department: 'Acting',
				profile_path: '/p.jpg',
				combined_credits: { cast: pastMovies(1) }
			})
		);
		const res = await GET(makeEvent({}));
		const data = (await res.json()) as PersonCreditsPage;

		expect(data.person).toEqual({
			tmdbId: 287,
			name: 'Brad Pitt',
			biography: 'An actor.',
			birthday: '1963-12-18',
			deathday: null,
			placeOfBirth: 'Shawnee, Oklahoma, USA',
			knownForDepartment: 'Acting',
			profilePath: '/p.jpg'
		});
		expect(data.credits).toEqual([
			{
				tmdbId: 1000,
				type: 'movie',
				title: 'Film 0',
				year: 1999,
				date: '1999-01-01',
				posterPath: null,
				role: 'Someone'
			}
		]);
		expect(data).toMatchObject({ page: 1, totalPages: 1, total: 1, upcoming: [] });
	});

	it('slices to the requested page', async () => {
		vi.stubGlobal('fetch', tmdbResponse({ id: 287, combined_credits: { cast: pastMovies(25) } }));
		const res = await GET(makeEvent({ page: '2' }));
		const data = (await res.json()) as PersonCreditsPage;

		expect(data).toMatchObject({ page: 2, totalPages: 2, total: 25 });
		expect(data.credits).toHaveLength(5);
		expect(data.credits[0].title).toBe('Film 20');
	});

	it('clamps an out-of-range or junk page to a real one', async () => {
		const body = { id: 287, combined_credits: { cast: pastMovies(3) } };
		vi.stubGlobal('fetch', tmdbResponse(body));

		const beyond = (await (await GET(makeEvent({ page: '99' }))).json()) as PersonCreditsPage;
		expect(beyond).toMatchObject({ page: 1, totalPages: 1 });

		const junk = (await (await GET(makeEvent({ page: 'nope' }))).json()) as PersonCreditsPage;
		expect(junk.page).toBe(1);
	});

	it('passes a TMDB 404 through as a 404', async () => {
		vi.stubGlobal('fetch', tmdbResponse({ status_message: 'not found' }, 404));
		const err = await thrownBy(() => GET(makeEvent({})));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(404);
	});

	it('maps a TMDB server error to a 502', async () => {
		vi.stubGlobal('fetch', tmdbResponse({}, 500));
		const err = await thrownBy(() => GET(makeEvent({ id: '288' })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(502);
	});
});
