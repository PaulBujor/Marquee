import { describe, expect, it } from 'vitest';
import { createTestDb } from '#lib/server/db/test-db.js';
import { episodeWatches, media, tracking, users } from '#lib/server/db/schema.js';
import { episodeKey, trackingKey } from '#lib/sync/events.js';
import { InvalidLibraryCursorError, LIBRARY_PAGE_MAX, readLibraryPage } from './read';

type Db = ReturnType<typeof createTestDb>;

const U1 = 'user-1';
const U2 = 'user-2';
/** Epoch ms the seeded rows are added at unless a test overrides it. */
const ADDED = Date.UTC(2026, 0, 1);

async function seedUser(db: Db, id: string): Promise<void> {
	await db.insert(users).values({ id, email: `${id}@test.dev`, status: 'enabled' });
}

async function seedMedia(
	db: Db,
	id: string,
	over: Partial<typeof media.$inferInsert> = {}
): Promise<void> {
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
	db: Db,
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

async function seed(db: Db): Promise<void> {
	await seedUser(db, U1);
	await seedUser(db, U2);
}

/** Walks every page and returns the media ids in read order, so a skipped or repeated row shows up. */
async function readAll(db: Db, userId: string, limit: number): Promise<string[][]> {
	const pages: string[][] = [];
	let cursor: string | null = null;
	for (let i = 0; i < 20; i++) {
		const page = await readLibraryPage(db, userId, { cursor, limit });
		pages.push(page.entries.map((entry) => entry.media.id));
		cursor = page.nextCursor;
		if (cursor === null) return pages;
	}
	throw new Error('paging never reached the last page');
}

describe('readLibraryPage', () => {
	it("returns only the authenticated user's titles", async () => {
		const db = createTestDb();
		await seed(db);
		for (const id of ['m1', 'm2', 'm3']) await seedMedia(db, id);
		await track(db, U1, 'm1');
		await track(db, U1, 'm2');
		await track(db, U2, 'm3');

		const page = await readLibraryPage(db, U1);

		expect(page.entries.map((entry) => entry.media.id).sort()).toEqual(['m1', 'm2']);
	});

	it('returns an empty page for a user with no library', async () => {
		const db = createTestDb();
		await seed(db);
		await seedMedia(db, 'm1');
		await track(db, U1, 'm1');

		expect(await readLibraryPage(db, 'nobody')).toEqual({ entries: [], nextCursor: null });
	});

	it("keeps each user's own state for a title they both track", async () => {
		const db = createTestDb();
		await seed(db);
		await seedMedia(db, 'shared');
		await track(db, U1, 'shared', { status: 'completed', favorite: true, rating: 4 });
		await track(db, U2, 'shared', { status: 'want_to_watch' });

		const [one] = (await readLibraryPage(db, U1)).entries;
		const [two] = (await readLibraryPage(db, U2)).entries;

		expect(one.tracking).toMatchObject({
			mediaId: 'shared',
			status: 'completed',
			favorite: true,
			rating: 4
		});
		expect(two.tracking).toMatchObject({
			mediaId: 'shared',
			status: 'want_to_watch',
			favorite: false,
			rating: null
		});
	});

	it('returns every row exactly once across pages', async () => {
		const db = createTestDb();
		await seed(db);
		const ids = ['m1', 'm2', 'm3', 'm4', 'm5'];
		for (const [i, id] of ids.entries()) {
			await seedMedia(db, id);
			await track(db, U1, id, { addedAt: new Date(ADDED + i * 1000) });
		}

		const pages = await readAll(db, U1, 2);

		expect(pages.length).toBeGreaterThan(1);
		expect(pages.every((page) => page.length <= 2)).toBe(true);
		// Newest add first, so the pages walk the seed order backwards.
		expect(pages.flat()).toEqual([...ids].reverse());
	});

	it('breaks timestamp ties by id so the cursor never skips or repeats a row', async () => {
		const db = createTestDb();
		await seed(db);
		for (const id of ['m1', 'm2', 'm3', 'm4']) {
			await seedMedia(db, id);
			await track(db, U1, id);
		}

		const pages = await readAll(db, U1, 2);
		const seen = pages.flat();

		expect(seen).toHaveLength(4);
		expect(new Set(seen).size).toBe(4);
	});

	it('includes removed titles as tombstones', async () => {
		const db = createTestDb();
		await seed(db);
		await seedMedia(db, 'gone');
		await track(db, U1, 'gone', { removed: true, removedUpdatedAt: 1234 });

		const [entry] = (await readLibraryPage(db, U1)).entries;

		expect(entry.tracking).toMatchObject({
			mediaId: 'gone',
			removed: true,
			removedUpdatedAt: 1234
		});
	});

	it('carries the show’s episode state and only that user’s watches', async () => {
		const db = createTestDb();
		await seed(db);
		await seedMedia(db, 'series', { type: 'show', externalId: 'tmdb/series' });
		await seedMedia(db, 'film');
		await track(db, U1, 'series');
		await track(db, U1, 'film');
		await db.insert(episodeWatches).values([
			{
				id: episodeKey(U1, 'series', 1, 2),
				userId: U1,
				mediaId: 'series',
				season: 1,
				episode: 2,
				watched: true,
				updatedAt: 1
			},
			{
				id: episodeKey(U1, 'series', 1, 1),
				userId: U1,
				mediaId: 'series',
				season: 1,
				episode: 1,
				watched: true,
				updatedAt: 2
			},
			{
				id: episodeKey(U1, 'series', 2, 1),
				userId: U1,
				mediaId: 'series',
				season: 2,
				episode: 1,
				watched: false,
				updatedAt: 3
			},
			{
				id: episodeKey(U2, 'series', 1, 3),
				userId: U2,
				mediaId: 'series',
				season: 1,
				episode: 3,
				watched: true,
				updatedAt: 4
			}
		]);

		const byMedia = new Map(
			(await readLibraryPage(db, U1)).entries.map((entry) => [entry.media.id, entry])
		);

		expect(byMedia.get('film')?.episodes).toBeNull();
		expect(byMedia.get('series')?.episodes).toEqual([
			{ season: 1, episode: 1, watched: true },
			{ season: 1, episode: 2, watched: true },
			{ season: 2, episode: 1, watched: false }
		]);
	});

	it('caps the page size at LIBRARY_PAGE_MAX', async () => {
		const db = createTestDb();
		await seed(db);
		for (let i = 0; i <= LIBRARY_PAGE_MAX; i++) {
			await seedMedia(db, `m${i}`);
			await track(db, U1, `m${i}`, { addedAt: new Date(ADDED + i * 1000) });
		}

		const page = await readLibraryPage(db, U1, { limit: 10_000 });

		expect(page.entries).toHaveLength(LIBRARY_PAGE_MAX);
		expect(page.nextCursor).not.toBeNull();
	});

	it('rejects a cursor it did not mint', async () => {
		const db = createTestDb();
		await seed(db);

		for (const cursor of ['not-a-cursor', '###', 'b64-not-a-count:abc']) {
			await expect(readLibraryPage(db, U1, { cursor })).rejects.toBeInstanceOf(
				InvalidLibraryCursorError
			);
		}
	});
});
