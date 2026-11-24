import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApi, type TestApi } from '#lib/testing/http.js';
import { apiTokens, episodeWatches, media, tracking, users } from '#lib/server/db/schema.js';
import { deleteAccount } from '#lib/server/auth/index.js';
import { LIBRARY_PAGE_MAX, type LibraryPage } from '#lib/server/library/read.js';
import { episodeKey, trackingKey } from '#lib/sync/events.js';
import { GET } from './+server';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const ADDED = Date.UTC(2026, 0, 1);

let api: TestApi;

beforeEach(async () => {
	api = await createTestApi();
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
