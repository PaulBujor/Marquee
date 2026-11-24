import { afterEach, describe, expect, it } from 'vitest';
import { media, mediaExternalIds } from '#lib/server/db/schema.js';
import { createTmdbClient, type TmdbClient } from '#lib/server/tmdb/index.js';
import { createTestApi, installTmdbFetch, type TestDb, type TmdbStub } from '#lib/testing/http.js';
import { resolveMediaIdOrHydrate } from './resolve';

const MATRIX_IMDB = 'tt0133093';

/** `/find` naming The Matrix on the movie side only. */
const FIND_MATRIX = { movie_results: [{ id: 603, title: 'The Matrix' }], tv_results: [] };

/** The details payload a hydrate of that id reads. */
const MATRIX_DETAILS = {
	id: 603,
	title: 'The Matrix',
	release_date: '1999-03-31',
	external_ids: { imdb_id: MATRIX_IMDB },
	credits: { cast: [], crew: [] }
};

let stub: TmdbStub | undefined;
afterEach(() => stub?.restore());

function tmdb(): TmdbClient {
	return createTmdbClient('test-key');
}

function findCalls(): number {
	return stub?.requested.filter((url) => url.includes('/find/')).length ?? 0;
}

async function mediaRowCount(db: TestDb): Promise<number> {
	return (await db.select({ id: media.id }).from(media)).length;
}

describe('resolveMediaIdOrHydrate', () => {
	it('resolves an unknown IMDb id to a stored title and records both aliases', async () => {
		const api = await createTestApi();
		stub = installTmdbFetch()
			.on('/3/find/' + MATRIX_IMDB, FIND_MATRIX)
			.on('/3/movie/603', MATRIX_DETAILS);

		const result = await resolveMediaIdOrHydrate(api.db, tmdb(), {
			type: 'movie',
			externalId: MATRIX_IMDB
		});

		const rows = await api.db.select().from(media);
		expect(rows).toHaveLength(1);
		expect(result).toEqual({ mediaId: rows[0].id });
		expect(rows[0]).toMatchObject({
			provider: 'tmdb',
			externalId: 'movie/603',
			title: 'The Matrix'
		});

		const aliases = (await api.db.select().from(mediaExternalIds)).map(
			(alias) => `${alias.provider}:${alias.externalId}`
		);
		expect(aliases.sort()).toEqual([`imdb:${MATRIX_IMDB}`, 'tmdb:movie/603']);
	});

	it('resolves the same IMDb id a second time without asking TMDB again', async () => {
		const api = await createTestApi();
		stub = installTmdbFetch()
			.on('/3/find/' + MATRIX_IMDB, FIND_MATRIX)
			.on('/3/movie/603', MATRIX_DETAILS);
		const target = { type: 'movie' as const, externalId: MATRIX_IMDB };

		const first = await resolveMediaIdOrHydrate(api.db, tmdb(), target);
		const requestsAfterFirst = stub.requested.length;
		const second = await resolveMediaIdOrHydrate(api.db, tmdb(), target);

		expect(second).toEqual(first);
		expect(requestsAfterFirst).toBe(2); // /find + the details hydrate
		expect(stub.requested.length).toBe(requestsAfterFirst);
	});

	it('resolves our own <type>/<id> form by hydrating, never through /find', async () => {
		const api = await createTestApi();
		stub = installTmdbFetch().on('/3/movie/603', MATRIX_DETAILS);

		const first = await resolveMediaIdOrHydrate(api.db, tmdb(), {
			type: 'movie',
			externalId: 'movie/603'
		});
		const requestsAfterFirst = stub.requested.length;
		const second = await resolveMediaIdOrHydrate(api.db, tmdb(), {
			type: 'movie',
			externalId: 'movie/603'
		});

		expect(await mediaRowCount(api.db)).toBe(1);
		expect(second).toEqual(first);
		expect(findCalls()).toBe(0);
		expect(stub.requested.length).toBe(requestsAfterFirst);
	});

	it('refuses a stored id of the other type rather than hydrating it', async () => {
		const api = await createTestApi();
		stub = installTmdbFetch();

		const result = await resolveMediaIdOrHydrate(api.db, tmdb(), {
			type: 'show',
			externalId: 'movie/603'
		});

		expect(result).toEqual({ unresolved: true });
		expect(await mediaRowCount(api.db)).toBe(0);
		expect(stub.requested).toEqual([]);
	});

	it('treats an empty external id as unresolved without asking TMDB', async () => {
		const api = await createTestApi();
		stub = installTmdbFetch();

		expect(
			await resolveMediaIdOrHydrate(api.db, tmdb(), { type: 'movie', externalId: '' })
		).toEqual({ unresolved: true });
		expect(stub.requested).toEqual([]);
		expect(await mediaRowCount(api.db)).toBe(0);
	});

	it('is unresolved when TMDB has never heard of the id, and stores nothing', async () => {
		const api = await createTestApi();
		stub = installTmdbFetch().on('/3/find/tt9999999', {});

		const result = await resolveMediaIdOrHydrate(api.db, tmdb(), {
			type: 'movie',
			externalId: 'tt9999999'
		});

		expect(result).toEqual({ unresolved: true });
		expect(await mediaRowCount(api.db)).toBe(0);
		expect(await api.db.select().from(mediaExternalIds)).toEqual([]);
	});

	it('is unresolved when the id names a title of each type, and stores nothing', async () => {
		const api = await createTestApi();
		stub = installTmdbFetch().on('/3/find/' + MATRIX_IMDB, {
			movie_results: [{ id: 603 }],
			tv_results: [{ id: 1396 }]
		});

		const result = await resolveMediaIdOrHydrate(api.db, tmdb(), {
			type: 'movie',
			externalId: MATRIX_IMDB
		});

		expect(result).toEqual({ unresolved: true });
		expect(await mediaRowCount(api.db)).toBe(0);
	});

	it('is unresolved when only the other type matched, and stores nothing', async () => {
		const api = await createTestApi();
		stub = installTmdbFetch().on('/3/find/' + MATRIX_IMDB, {
			movie_results: [],
			tv_results: [{ id: 1396 }]
		});

		const result = await resolveMediaIdOrHydrate(api.db, tmdb(), {
			type: 'movie',
			externalId: MATRIX_IMDB
		});

		expect(result).toEqual({ unresolved: true });
		expect(await mediaRowCount(api.db)).toBe(0);
	});

	it('throws a retryable error when TMDB fails, leaving no row and no alias behind', async () => {
		const api = await createTestApi();
		stub = installTmdbFetch().on('/3/find/' + MATRIX_IMDB, {}, { status: 500 });

		await expect(
			resolveMediaIdOrHydrate(api.db, tmdb(), { type: 'movie', externalId: MATRIX_IMDB })
		).rejects.toMatchObject({ name: 'TmdbError', status: 500 });

		expect(await mediaRowCount(api.db)).toBe(0);
		expect(await api.db.select().from(mediaExternalIds)).toEqual([]);
	});

	it('stores one title when two callers resolve the same id at once', async () => {
		const api = await createTestApi();
		stub = installTmdbFetch()
			.on('/3/find/' + MATRIX_IMDB, FIND_MATRIX)
			.on('/3/movie/603', MATRIX_DETAILS);
		const target = { type: 'movie' as const, externalId: MATRIX_IMDB };

		const results = await Promise.all([
			resolveMediaIdOrHydrate(api.db, tmdb(), target),
			resolveMediaIdOrHydrate(api.db, tmdb(), target)
		]);

		const rows = await api.db.select().from(media);
		expect(rows).toHaveLength(1);
		expect(results).toEqual([{ mediaId: rows[0].id }, { mediaId: rows[0].id }]);
	});
});
