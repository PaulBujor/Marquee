import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApi, installTmdbFetch, type TestApi, type TmdbStub } from '#lib/testing/http.js';
import { setTestBindings } from '#lib/server/test/cloudflare-workers.js';
import { episodeWatches, events, media, tracking } from '#lib/server/db/schema.js';
import { seedMediaId, trackingKey } from '#lib/sync/events.js';
import type { LibraryEntry, LibraryPage } from '#lib/server/library/read.js';
import { PATCH } from './+server';
import { GET as GET_LIBRARY } from '../../+server';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const ADDED = Date.UTC(2026, 0, 1);

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

const MOVIE = seedMediaId('tmdb', 'movie/603');

async function seedMedia(id: string, over: Partial<typeof media.$inferInsert> = {}): Promise<void> {
	await api.db.insert(media).values({
		id,
		provider: 'tmdb',
		externalId: `movie/${id.replace(/\W/g, '')}`,
		type: 'movie',
		title: `title-${id}`,
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

async function patch(
	options: { type?: string; id?: string; token?: string | null; body?: unknown } = {}
): Promise<Response> {
	const { type = 'movie', id = MOVIE, token = api.alice.token, body = {} } = options;
	return api.call(PATCH, {
		path: `/api/v1/library/${type}/${id}`,
		method: 'PATCH',
		token,
		body,
		params: { type, id }
	});
}

async function eventCount(): Promise<number> {
	return (await api.db.select({ id: events.id }).from(events)).length;
}

async function libraryFor(token: string): Promise<LibraryEntry[]> {
	const res = await api.call(GET_LIBRARY, { path: '/api/v1/library', token });
	expect(res.status).toBe(200);
	return ((await res.json()) as LibraryPage).entries;
}

describe('PATCH /api/v1/library/{type}/{id}', () => {
	it('401s without a bearer token', async () => {
		const res = await patch({ token: null, body: { status: 'completed' } });

		expect(res.status).toBe(401);
		expect(res.headers.get('www-authenticate')).toBe('Bearer');
	});

	it('400s a type outside the vocabulary, without writing anything', async () => {
		await seedMedia(MOVIE);

		const res = await patch({ type: 'tv', body: { status: 'completed' } });

		expect(res.status).toBe(400);
		expect(await eventCount()).toBe(0);
	});

	it('applies the change to the token owner, and a following GET agrees', async () => {
		await seedMedia(MOVIE);

		const res = await patch({ body: { status: 'completed', rating: 4 } });
		expect(res.status).toBe(200);
		const entry = (await res.json()) as LibraryEntry;

		expect(entry.media.id).toBe(MOVIE);
		expect(entry.tracking).toMatchObject({
			mediaId: MOVIE,
			status: 'completed',
			rating: 4,
			favorite: false,
			removed: false
		});

		const [read] = await libraryFor(api.alice.token);
		expect(read.tracking).toEqual(entry.tracking);
		expect(read.media).toEqual(entry.media);
		expect(await libraryFor(api.bob.token)).toEqual([]);
	});

	it('is idempotent: replaying the identical PATCH settles on the same state', async () => {
		await seedMedia(MOVIE);
		const body = { status: 'watching', favorite: true, rating: 3 };

		const first = await patch({ body });
		const afterFirst = await eventCount();
		const second = await patch({ body });

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(await second.json()).toEqual(await first.json());
		expect(await eventCount()).toBe(afterFirst);

		const [read] = await libraryFor(api.alice.token);
		expect(read.tracking).toMatchObject({ status: 'watching', favorite: true, rating: 3 });
	});

	it("404s another user's private title and leaves their row untouched", async () => {
		const privateId = '0190a3f0-0000-7000-8000-000000000001';
		await seedMedia(privateId, {
			provider: 'tmdb',
			externalId: null,
			source: 'custom',
			ownerUserId: BOB,
			title: 'Bob private'
		});
		await track(BOB, privateId, { status: 'want_to_watch' });

		const res = await patch({ id: privateId, body: { status: 'completed' } });

		expect(res.status).toBe(404);
		const [bobRow] = await api.db.select().from(tracking);
		expect(bobRow).toMatchObject({ userId: BOB, mediaId: privateId, status: 'want_to_watch' });
		expect(await eventCount()).toBe(0);
	});

	it('resolves an IMDb id nobody stored, hydrates it, then applies the command', async () => {
		stub = installTmdbFetch()
			.on('/3/find/' + MATRIX_IMDB, FIND_MATRIX)
			.on('/3/movie/603', MATRIX_DETAILS);

		const res = await patch({ id: MATRIX_IMDB, body: { status: 'watching' } });
		expect(res.status).toBe(200);
		const entry = (await res.json()) as LibraryEntry;

		const rows = await api.db.select().from(media);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ externalId: 'movie/603', title: 'The Matrix' });
		expect(entry.tracking).toMatchObject({ mediaId: rows[0].id, status: 'watching' });
		expect(entry.media).toMatchObject({ provider: 'tmdb', externalId: 'movie/603' });

		const [read] = await libraryFor(api.alice.token);
		expect(read.tracking.mediaId).toBe(rows[0].id);
	});

	it('422s an id that names no title, and stores nothing', async () => {
		stub = installTmdbFetch().on('/3/find/tt9999999', { movie_results: [], tv_results: [] });

		const res = await patch({ id: 'tt9999999', body: { status: 'watching' } });

		expect(res.status).toBe(422);
		expect(await api.db.select().from(media)).toEqual([]);
		expect(await eventCount()).toBe(0);
	});

	it('502s a TMDB failure rather than calling the id unresolved', async () => {
		stub = installTmdbFetch().on('/3/find/' + MATRIX_IMDB, { message: 'nope' }, { status: 500 });

		const res = await patch({ id: MATRIX_IMDB, body: { status: 'watching' } });

		expect(res.status).toBe(502);
	});

	it('400s an invalid body, and writes no events', async () => {
		await seedMedia(MOVIE);

		for (const body of [{ rating: 9 }, { status: 'bogus' }, {}, { rating: 'five' }]) {
			const res = await patch({ body });
			expect(res.status).toBe(400);
		}
		expect(await eventCount()).toBe(0);
		expect(await api.db.select().from(tracking)).toEqual([]);
	});

	it('marks episodes for a show and returns the resulting watch state', async () => {
		const showId = seedMediaId('tmdb', 'show/1396');
		await seedMedia(showId, { externalId: 'show/1396', type: 'show', title: 'Breaking Bad' });
		await api.db.insert(episodeWatches).values({
			id: `${ALICE}::${showId}::s1e1`,
			userId: ALICE,
			mediaId: showId,
			season: 1,
			episode: 1,
			watched: true,
			updatedAt: ADDED
		});
		await track(ALICE, showId, { status: 'watching' });

		const res = await patch({
			type: 'show',
			id: showId,
			body: { episodes: [{ season: 1, episode: 2, watched: true }] }
		});
		expect(res.status).toBe(200);

		const entry = (await res.json()) as LibraryEntry;
		expect(entry.episodes).toEqual([
			{ season: 1, episode: 1, watched: true },
			{ season: 1, episode: 2, watched: true }
		]);
	});
});
