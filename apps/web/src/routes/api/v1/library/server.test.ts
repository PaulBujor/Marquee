import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApi, installTmdbFetch, type TestApi, type TmdbStub } from '#lib/testing/http.js';
import { setTestBindings } from '#lib/server/test/cloudflare-workers.js';
import {
	apiTokens,
	episodeWatches,
	events,
	media,
	tracking,
	users
} from '#lib/server/db/schema.js';
import { deleteAccount } from '#lib/server/auth/index.js';
import { LIBRARY_PAGE_MAX, type LibraryPage } from '#lib/server/library/read.js';
import { episodeKey, seedMediaId, trackingKey } from '#lib/sync/events.js';
import { GET, LIBRARY_BATCH_MAX, POST, type LibraryBatchResult } from './+server';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const ADDED = Date.UTC(2026, 0, 1);

let api: TestApi;
let stub: TmdbStub | undefined;

beforeEach(async () => {
	api = await createTestApi();
	setTestBindings({ TMDB_API_KEY: 'test-key' });
});
afterEach(() => {
	stub?.restore();
	stub = undefined;
});

async function seedMedia(id: string, over: Partial<typeof media.$inferInsert> = {}): Promise<void> {
	await api.db.insert(media).values({
		id,
		provider: 'tmdb',
		externalId: `tmdb/${id}`,
		type: 'movie',
		title: `title-${id}`,
		year: 1999,
		posterPath: '/poster.jpg',
		...over
	});
}

async function track(
	userId: string,
	mediaId: string,
	over: Partial<typeof tracking.$inferInsert> = {}
): Promise<void> {
	await api.db.insert(tracking).values({
		id: trackingKey(userId, mediaId),
		userId,
		mediaId,
		addedAt: new Date(ADDED),
		updatedAt: new Date(ADDED),
		...over
	});
}

/** Alice and Bob both track m1; Alice also has a show with a watched episode, Bob a title of his own. */
async function seedOverlappingLibraries(): Promise<void> {
	await seedMedia('m1');
	await seedMedia('m2', { type: 'show', title: 'title-m2' });
	await seedMedia('m3');
	await track(ALICE, 'm1', { status: 'completed', rating: 5 });
	await track(ALICE, 'm2', { status: 'watching', addedAt: new Date(ADDED + 1000) });
	await api.db.insert(episodeWatches).values({
		id: episodeKey(ALICE, 'm2', 1, 1),
		userId: ALICE,
		mediaId: 'm2',
		season: 1,
		episode: 1,
		watched: true,
		updatedAt: ADDED
	});
	await track(BOB, 'm1', { status: 'want_to_watch' });
	await track(BOB, 'm3', { addedAt: new Date(ADDED + 2000) });
}

async function getPage(token: string, query = ''): Promise<LibraryPage> {
	const res = await api.call(GET, { path: `/api/v1/library${query}`, token });
	expect(res.status).toBe(200);
	return (await res.json()) as LibraryPage;
}

describe('GET /api/v1/library', () => {
	it('401s with WWW-Authenticate when no bearer token is sent', async () => {
		const res = await api.call(GET, { path: '/api/v1/library' });

		expect(res.status).toBe(401);
		expect(res.headers.get('www-authenticate')).toBe('Bearer');
		expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
	});

	it('401s a session without a bearer token: the token is the only identity', async () => {
		await seedOverlappingLibraries();

		expect((await api.call(GET, { path: '/api/v1/library', user: { id: ALICE } })).status).toBe(
			401
		);
	});

	it('401s a revoked token', async () => {
		await seedOverlappingLibraries();
		await api.db
			.update(apiTokens)
			.set({ revokedAt: new Date() })
			.where(eq(apiTokens.id, api.alice.row.id));

		expect((await api.call(GET, { path: '/api/v1/library', token: api.alice.token })).status).toBe(
			401
		);
	});

	it('401s a token whose user was deleted', async () => {
		await seedOverlappingLibraries();
		const [alice] = await api.db.select().from(users).where(eq(users.id, ALICE));
		await deleteAccount(api.db, alice);

		expect((await api.call(GET, { path: '/api/v1/library', token: api.alice.token })).status).toBe(
			401
		);
	});

	it('503s without a db', async () => {
		const res = await api.call(GET, { path: '/api/v1/library', token: api.alice.token, db: null });

		expect(res.status).toBe(503);
	});

	it("returns only the token owner's entries, with that owner's state", async () => {
		await seedOverlappingLibraries();

		const asAlice = await getPage(api.alice.token);
		const asBob = await getPage(api.bob.token);

		expect(Object.keys(asAlice).sort()).toEqual(['entries', 'nextCursor']);
		expect(asAlice.entries.map((entry) => entry.media.id)).toEqual(['m2', 'm1']);
		expect(asAlice.entries[1].tracking).toMatchObject({ status: 'completed', rating: 5 });
		expect(asAlice.entries[0].episodes).toEqual([{ season: 1, episode: 1, watched: true }]);

		expect(asBob.entries.map((entry) => entry.media.id)).toEqual(['m3', 'm1']);
		expect(asBob.entries[1].tracking).toMatchObject({ status: 'want_to_watch', rating: null });
		expect(asBob.entries[1].episodes).toBeNull();

		expect(JSON.stringify(asAlice)).not.toContain('m3');
		expect(JSON.stringify(asBob)).not.toContain('m2');
	});

	it('pages with limit and continues from the returned cursor', async () => {
		await seedOverlappingLibraries();

		const first = await getPage(api.alice.token, '?limit=1');
		expect(first.entries.map((entry) => entry.media.id)).toEqual(['m2']);
		expect(first.nextCursor).not.toBeNull();

		const second = await getPage(
			api.alice.token,
			`?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`
		);
		expect(second.entries.map((entry) => entry.media.id)).toEqual(['m1']);
		expect(second.nextCursor).toBeNull();
	});

	it('400s a cursor it never issued', async () => {
		await seedOverlappingLibraries();

		const res = await api.call(GET, {
			path: '/api/v1/library?cursor=not-a-cursor',
			token: api.alice.token
		});

		expect(res.status).toBe(400);
		expect(((await res.json()) as { type: string }).type).toBe('invalid_cursor');
	});

	it('400s a limit that is non-numeric, fractional or out of range', async () => {
		await seedOverlappingLibraries();

		for (const limit of ['abc', '1.5', '0', '-1', String(LIBRARY_PAGE_MAX + 1)]) {
			const res = await api.call(GET, {
				path: `/api/v1/library?limit=${limit}`,
				token: api.alice.token
			});
			expect(res.status).toBe(400);
		}
	});
});

/** Real ids, because a UUID is taken as ours while anything else goes to TMDB. */
const MOVIE_A = seedMediaId('tmdb', 'movie/603');
const MOVIE_B = seedMediaId('tmdb', 'movie/604');
const SHOW = seedMediaId('tmdb', 'show/1396');
const PRIVATE = '0190a3f0-0000-7000-8000-000000000001';

/** The Matrix, as TMDB answers it: one movie on the `/find` side, then the details a hydrate reads. */
const MATRIX_IMDB = 'tt0133093';
const FIND_MATRIX = { movie_results: [{ id: 603, title: 'The Matrix' }], tv_results: [] };
const MATRIX_DETAILS = {
	id: 603,
	title: 'The Matrix',
	release_date: '1999-03-31',
	external_ids: { imdb_id: MATRIX_IMDB },
	credits: { cast: [], crew: [] }
};

async function postBatch(
	options: { body?: unknown; token?: string | null } = {}
): Promise<Response> {
	const { body = {}, token = api.alice.token } = options;
	return api.call(POST, { path: '/api/v1/library', method: 'POST', token, body });
}

async function eventCount(): Promise<number> {
	return (await api.db.select({ id: events.id }).from(events)).length;
}

describe('POST /api/v1/library', () => {
	it('401s without a bearer token, and writes nothing', async () => {
		await seedMedia(MOVIE_A);

		const res = await postBatch({ token: null, body: { items: [] } });

		expect(res.status).toBe(401);
		expect(res.headers.get('www-authenticate')).toBe('Bearer');
		expect(await eventCount()).toBe(0);
	});

	it('applies a batch of two movies and a show, and a following GET agrees', async () => {
		await seedMedia(MOVIE_A);
		await seedMedia(MOVIE_B);
		await seedMedia(SHOW, { type: 'show', title: 'title-show' });

		const res = await postBatch({
			body: {
				items: [
					{ type: 'movie', id: MOVIE_A, status: 'completed', rating: 5 },
					{ type: 'movie', id: MOVIE_B, status: 'want_to_watch', favorite: true },
					{
						type: 'show',
						id: SHOW,
						status: 'watching',
						episodes: [{ season: 1, episode: 1, watched: true }]
					}
				]
			}
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual<LibraryBatchResult>({
			applied: 3,
			unchanged: 0,
			failed: []
		});

		const byId = new Map((await getPage(api.alice.token)).entries.map((e) => [e.media.id, e]));
		expect(byId.get(MOVIE_A)!.tracking).toMatchObject({ status: 'completed', rating: 5 });
		expect(byId.get(MOVIE_B)!.tracking).toMatchObject({
			status: 'want_to_watch',
			favorite: true
		});
		expect(byId.get(SHOW)!.tracking).toMatchObject({ status: 'watching' });
		expect(byId.get(SHOW)!.episodes).toEqual([{ season: 1, episode: 1, watched: true }]);
	});

	it('is idempotent: replaying the identical batch changes nothing and still answers 200', async () => {
		await seedMedia(MOVIE_A);
		await seedMedia(MOVIE_B);
		const body = {
			items: [
				{ type: 'movie', id: MOVIE_A, status: 'completed', rating: 4 },
				{ type: 'movie', id: MOVIE_B, status: 'watching' }
			]
		};

		const first = await postBatch({ body });
		const afterFirst = await eventCount();
		const pageAfterFirst = await getPage(api.alice.token);
		const second = await postBatch({ body });

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(await second.json()).toEqual<LibraryBatchResult>({
			applied: 0,
			unchanged: 2,
			failed: []
		});
		expect(await eventCount()).toBe(afterFirst);
		expect(await getPage(api.alice.token)).toEqual(pageAfterFirst);
	});

	it('reports an unresolvable id while its siblings still apply', async () => {
		await seedMedia(MOVIE_A);
		stub = installTmdbFetch().on('/3/find/tt9999999', { movie_results: [], tv_results: [] });

		const res = await postBatch({
			body: {
				items: [
					{ type: 'movie', id: 'tt9999999', status: 'completed' },
					{ type: 'movie', id: MOVIE_A, status: 'completed' }
				]
			}
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual<LibraryBatchResult>({
			applied: 1,
			unchanged: 0,
			failed: [
				{ id: 'tt9999999', code: 'unresolved', reason: expect.stringContaining('single title') }
			]
		});
		expect((await getPage(api.alice.token)).entries.map((e) => e.media.id)).toEqual([MOVIE_A]);
		expect(await api.db.select().from(media)).toHaveLength(1);
	});

	it('keeps the rest of the batch when one title hits a TMDB rate limit', async () => {
		stub = installTmdbFetch()
			.on('/3/find/tt0133093', { message: 'rate limited' }, { status: 429 })
			.on('/3/find/tt0000002', FIND_MATRIX)
			.on('/3/movie/603', MATRIX_DETAILS);

		const res = await postBatch({
			body: {
				items: [
					{ type: 'movie', id: MATRIX_IMDB, status: 'completed' },
					{ type: 'movie', id: 'tt0000002', status: 'watching' }
				]
			}
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual<LibraryBatchResult>({
			applied: 1,
			unchanged: 0,
			failed: [
				{
					id: MATRIX_IMDB,
					code: 'upstream_unavailable',
					reason: expect.stringContaining('Retry')
				}
			]
		});
		const [entry] = (await getPage(api.alice.token)).entries;
		expect(entry.tracking).toMatchObject({ status: 'watching' });
		expect(entry.media.title).toBe('The Matrix');
	});

	it('400s a batch over the cap and writes nothing', async () => {
		const items = Array.from({ length: LIBRARY_BATCH_MAX + 1 }, (_, i) => ({
			type: 'movie',
			id: `0190a3f0-0000-7000-8000-${String(i).padStart(12, '0')}`,
			status: 'want_to_watch'
		}));

		const res = await postBatch({ body: { items } });

		expect(res.status).toBe(400);
		expect(await eventCount()).toBe(0);
		expect(await api.db.select().from(tracking)).toEqual([]);
	});

	it("404s another user's private title per item, and leaves their rows untouched", async () => {
		await seedMedia(MOVIE_A);
		await seedMedia(PRIVATE, {
			provider: 'tmdb',
			externalId: null,
			source: 'custom',
			ownerUserId: ALICE
		});
		await track(ALICE, MOVIE_A, { status: 'completed' });
		await track(ALICE, PRIVATE, { status: 'want_to_watch' });

		const res = await postBatch({
			token: api.bob.token,
			body: {
				items: [
					{ type: 'movie', id: PRIVATE, status: 'completed' },
					{ type: 'movie', id: MOVIE_A, status: 'watching' }
				]
			}
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual<LibraryBatchResult>({
			applied: 1,
			unchanged: 0,
			failed: [{ id: PRIVATE, code: 'not_found', reason: expect.stringContaining('No such title') }]
		});

		const rows = await api.db.select().from(tracking);
		const rowFor = (userId: string, mediaId: string) =>
			rows.find((row) => row.userId === userId && row.mediaId === mediaId);
		expect(rowFor(ALICE, PRIVATE)).toMatchObject({ status: 'want_to_watch' });
		expect(rowFor(ALICE, MOVIE_A)).toMatchObject({ status: 'completed' });
		expect(rowFor(BOB, MOVIE_A)).toMatchObject({ status: 'watching' });
		expect(rowFor(BOB, PRIVATE)).toBeUndefined();
		expect((await api.db.select().from(events)).every((row) => row.userId === BOB)).toBe(true);
	});
});

describe('POST /api/v1/library event origin', () => {
	it('refuses an item that declares its own origin, and writes nothing', async () => {
		await seedMedia(MOVIE_A);

		const res = await postBatch({
			body: {
				items: [{ type: 'movie', id: MOVIE_A, status: 'completed', origin: 'app' }]
			}
		});

		expect(res.status).toBe(400);
		expect(await eventCount()).toBe(0);
	});

	it('records the API surface and the token that wrote each event', async () => {
		await seedMedia(MOVIE_A);
		await seedMedia(MOVIE_B);

		const res = await postBatch({
			body: {
				items: [
					{ type: 'movie', id: MOVIE_A, status: 'completed' },
					{ type: 'movie', id: MOVIE_B, favorite: true }
				]
			}
		});
		expect(res.status).toBe(200);

		const rows = await api.db.select().from(events);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows)
			expect(row).toMatchObject({ origin: 'api', apiTokenId: api.alice.row.id });
	});
});
