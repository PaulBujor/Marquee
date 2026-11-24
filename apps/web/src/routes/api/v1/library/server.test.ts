import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '#lib/server/db/test-db.js';
import { apiTokens, episodeWatches, media, tracking, users } from '#lib/server/db/schema.js';
import { createApiToken } from '#lib/server/api/auth.js';
import { LIBRARY_PAGE_MAX, type LibraryPage } from '#lib/server/library/read.js';
import { episodeKey, trackingKey } from '#lib/sync/events.js';
import { GET } from './+server';

type Db = ReturnType<typeof createTestDb>;

const ALICE = 'user-alice';
const BOB = 'user-bob';
const ADDED = Date.UTC(2026, 0, 1);

let db: Db;

beforeEach(async () => {
	db = createTestDb();
	await db.insert(users).values([
		{ id: ALICE, email: 'alice@example.com', status: 'enabled' },
		{ id: BOB, email: 'bob@example.com', status: 'enabled' }
	]);
});

function libraryEvent(token: string | null, query = '', database: Db | null = db) {
	const url = `https://marquee.test/api/v1/library${query}`;
	return {
		locals: { db: database ?? undefined },
		url: new URL(url),
		request: new Request(url, {
			headers: token ? { authorization: `Bearer ${token}` } : undefined
		})
	} as unknown as Parameters<typeof GET>[0];
}

async function seedMedia(id: string, over: Partial<typeof media.$inferInsert> = {}): Promise<void> {
	await db.insert(media).values({
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
	await db.insert(tracking).values({
		id: trackingKey(userId, mediaId),
		userId,
		mediaId,
		addedAt: new Date(ADDED),
		updatedAt: new Date(ADDED),
		...over
	});
}

/** Both users track m1 with different state; Alice also has a show with a watched episode. */
async function seedOverlappingLibraries(): Promise<{ alice: string; bob: string }> {
	await seedMedia('m1');
	await seedMedia('m2', { type: 'show', title: 'title-m2' });
	await track(ALICE, 'm1', { status: 'completed', rating: 5 });
	await track(ALICE, 'm2', { status: 'watching', addedAt: new Date(ADDED + 1000) });
	await db.insert(episodeWatches).values({
		id: episodeKey(ALICE, 'm2', 1, 1),
		userId: ALICE,
		mediaId: 'm2',
		season: 1,
		episode: 1,
		watched: true,
		updatedAt: ADDED
	});
	await track(BOB, 'm1', { status: 'want_to_watch' });

	const alice = await createApiToken(db, ALICE, 'alice');
	const bob = await createApiToken(db, BOB, 'bob');
	return { alice: alice.token, bob: bob.token };
}

async function getPage(event: Parameters<typeof GET>[0]): Promise<unknown> {
	const res = await GET(event);
	expect(res.status).toBe(200);
	return res.json();
}

describe('GET /api/v1/library', () => {
	it('401s with WWW-Authenticate when no bearer token is sent', async () => {
		const res = await GET(libraryEvent(null));

		expect(res.status).toBe(401);
		expect(res.headers.get('www-authenticate')).toBe('Bearer');
		expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
	});

	it('401s a revoked token', async () => {
		const { alice } = await seedOverlappingLibraries();
		const [row] = await db
			.select({ id: apiTokens.id })
			.from(apiTokens)
			.where(eq(apiTokens.userId, ALICE));
		await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, row.id));

		expect((await GET(libraryEvent(alice))).status).toBe(401);
	});

	it('503s without a db', async () => {
		expect((await GET(libraryEvent('mqr_x', '', null))).status).toBe(503);
	});

	it("returns only the token owner's entries, with that owner's state", async () => {
		const { alice, bob } = await seedOverlappingLibraries();

		const asAlice = (await getPage(libraryEvent(alice))) as LibraryPage;
		const asBob = (await getPage(libraryEvent(bob))) as LibraryPage;

		expect(Object.keys(asAlice).sort()).toEqual(['entries', 'nextCursor']);
		expect(asAlice.entries.map((entry) => entry.media.id)).toEqual(['m2', 'm1']);
		expect(asAlice.entries[1].tracking).toMatchObject({ status: 'completed', rating: 5 });
		expect(asAlice.entries[0].episodes).toEqual([{ season: 1, episode: 1, watched: true }]);

		expect(asBob.entries.map((entry) => entry.media.id)).toEqual(['m1']);
		expect(asBob.entries[0].tracking).toMatchObject({ status: 'want_to_watch', rating: null });
		expect(asBob.entries[0].episodes).toBeNull();
	});

	it('pages with limit and continues from the returned cursor', async () => {
		const { alice } = await seedOverlappingLibraries();

		const first = (await getPage(libraryEvent(alice, '?limit=1'))) as LibraryPage;
		expect(first.entries.map((entry) => entry.media.id)).toEqual(['m2']);
		expect(first.nextCursor).not.toBeNull();

		const second = (await getPage(
			libraryEvent(alice, `?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`)
		)) as LibraryPage;
		expect(second.entries.map((entry) => entry.media.id)).toEqual(['m1']);
		expect(second.nextCursor).toBeNull();
	});

	it('400s a cursor it never issued', async () => {
		const { alice } = await seedOverlappingLibraries();

		const res = await GET(libraryEvent(alice, '?cursor=not-a-cursor'));
		expect(res.status).toBe(400);
		expect(((await res.json()) as { type: string }).type).toBe('invalid_cursor');
	});

	it('400s a limit that is non-numeric, fractional or out of range', async () => {
		const { alice } = await seedOverlappingLibraries();

		for (const limit of ['abc', '1.5', '0', '-1', String(LIBRARY_PAGE_MAX + 1)])
			expect((await GET(libraryEvent(alice, `?limit=${limit}`))).status).toBe(400);
	});
});
