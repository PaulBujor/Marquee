import { afterEach, describe, expect, it } from 'vitest';
import { error } from '@sveltejs/kit';
import { authenticateApiToken } from '#lib/server/api/auth.js';
import { createTestApi, installTmdbFetch, type TestEvent } from './http.js';

describe('createTestApi', () => {
	it('seeds two users with real tokens that authenticate against the seeded db', async () => {
		const api = await createTestApi();

		const asBearer = (token: string) =>
			new Request('https://marquee.test/api/v1/library', {
				headers: { authorization: `Bearer ${token}` }
			});

		expect(await authenticateApiToken(asBearer(api.alice.token), api.db)).toMatchObject({
			userId: api.alice.id,
			tokenId: api.alice.row.id
		});
		expect(await authenticateApiToken(asBearer(api.bob.token), api.db)).toMatchObject({
			userId: api.bob.id
		});
	});

	it('hands the handler a real Request and locals, and returns its Response', async () => {
		const api = await createTestApi();

		const response = await api.call(
			({ request, url, locals }: TestEvent) => {
				expect(request.headers.get('authorization')).toBe(`Bearer ${api.alice.token}`);
				expect(request.method).toBe('POST');
				expect(url.pathname).toBe('/api/v1/library');
				expect(url.searchParams.get('limit')).toBe('1');
				expect(locals.db).toBe(api.db);
				expect(locals.user).toBeNull();
				return Response.json({ ok: true });
			},
			{
				path: '/api/v1/library?limit=1',
				method: 'POST',
				token: api.alice.token,
				body: { label: 'x' }
			}
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});

	it('turns a thrown error() into the JSON response SvelteKit would send', async () => {
		const api = await createTestApi();

		const response = await api.call(() => error(401, 'Unauthorized'));

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ status: 401, message: 'Unauthorized' });
	});

	it('leaves locals.db undefined when the db is null', async () => {
		const api = await createTestApi();

		const response = await api.call(
			({ locals }: TestEvent) => Response.json({ db: locals.db ?? null }),
			{ db: null }
		);

		expect(await response.json()).toEqual({ db: null });
	});
});

describe('installTmdbFetch', () => {
	let stub: ReturnType<typeof installTmdbFetch> | undefined;

	afterEach(() => stub?.restore());

	it('answers registered TMDB paths and records the request', async () => {
		stub = installTmdbFetch().on('/3/movie/1', { id: 1, title: 'Inception' });

		const response = await fetch('https://api.themoviedb.org/3/movie/1?api_key=k');

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ id: 1, title: 'Inception' });
		expect(stub.requested).toEqual(['https://api.themoviedb.org/3/movie/1?api_key=k']);
	});

	it('fails loudly on a URL no test registered', async () => {
		stub = installTmdbFetch().on('/3/movie/1', { id: 1 });

		await expect(fetch('https://api.themoviedb.org/3/movie/2')).rejects.toThrow(
			/Unstubbed fetch: https:\/\/api\.themoviedb\.org\/3\/movie\/2/
		);
		await expect(fetch('https://example.com/anything')).rejects.toThrow(/Unstubbed fetch/);
	});

	it('restores the previous global fetch', async () => {
		const original = globalThis.fetch;
		stub = installTmdbFetch();
		stub.restore();
		expect(globalThis.fetch).toBe(original);
		stub = undefined;
	});
});
