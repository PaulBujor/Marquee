import { describe, expect, it } from 'vitest';
import { createTestDb } from '#lib/server/db/test-db.js';
import { episodeWatches, events, media, tracking, users } from '#lib/server/db/schema.js';
import { countUsage, countUsersByStatus } from './metrics.js';

type Db = ReturnType<typeof createTestDb>;

const DAY = 86_400_000;

async function seed(db: Db) {
	await db.insert(users).values({ id: 'u-1', email: 'a@example.com', status: 'enabled' });
	await db.insert(users).values({ id: 'u-2', email: 'b@example.com', status: 'pending' });
	await db.insert(users).values({ id: 'u-3', email: 'c@example.com', status: 'blocked' });

	await db.insert(media).values({ id: 'm-1', type: 'movie', title: 'The Matrix' });
	await db.insert(media).values({ id: 'm-2', type: 'show', title: 'Severance' });

	await db.insert(tracking).values({
		id: 't-1',
		userId: 'u-1',
		mediaId: 'm-1',
		status: 'completed',
		favorite: true,
		rating: 9
	});
	await db
		.insert(tracking)
		.values({ id: 't-2', userId: 'u-1', mediaId: 'm-2', status: 'watching' });
	// A tombstone: removed rows are not live library data.
	await db.insert(tracking).values({
		id: 't-3',
		userId: 'u-2',
		mediaId: 'm-2',
		status: 'completed',
		removed: true
	});

	await db.insert(episodeWatches).values({
		id: 'e-1',
		userId: 'u-1',
		mediaId: 'm-2',
		season: 1,
		episode: 1,
		watched: true
	});
	await db.insert(episodeWatches).values({
		id: 'e-2',
		userId: 'u-1',
		mediaId: 'm-2',
		season: 1,
		episode: 2,
		watched: true
	});
	await db.insert(episodeWatches).values({
		id: 'e-3',
		userId: 'u-1',
		mediaId: 'm-2',
		season: 1,
		episode: 3,
		watched: false
	});
}

let sequence = 0;

async function seedEvent(db: Db, id: string, userId: string, daysAgo: number, now: Date) {
	sequence += 1;
	await db.insert(events).values({
		id,
		userId,
		sequence,
		type: 'tracking.added',
		entityId: 'entity-1',
		payload: {},
		deviceId: 'device-1',
		clientCreatedAt: now.getTime() - daysAgo * DAY,
		serverReceivedAt: new Date(now.getTime() - daysAgo * DAY)
	});
}

describe('countUsersByStatus', () => {
	it('counts every status, including ones with no rows', async () => {
		const db = createTestDb();
		await seed(db);

		expect(await countUsersByStatus(db)).toEqual({ pending: 1, enabled: 1, blocked: 1 });
	});

	it('reports zeros on an empty database', async () => {
		const db = createTestDb();
		expect(await countUsersByStatus(db)).toEqual({ pending: 0, enabled: 0, blocked: 0 });
	});
});

describe('countUsage', () => {
	it('counts live library rows and ignores tombstones', async () => {
		const db = createTestDb();
		await seed(db);

		expect(await countUsage(db)).toMatchObject({
			movies: 1,
			shows: 1,
			watched: 1,
			favourites: 1,
			rated: 1,
			episodesWatched: 2
		});
	});

	it('counts distinct active users by when the server received the event', async () => {
		const db = createTestDb();
		await seed(db);
		const now = new Date();
		await seedEvent(db, 'ev-1', 'u-1', 3, now);
		await seedEvent(db, 'ev-2', 'u-2', 20, now);
		await seedEvent(db, 'ev-3', 'u-1', 40, now);

		const usage = await countUsage(db, now);
		// u-1 appears twice inside the week; distinct is what matters.
		expect(usage.activeWeek).toBe(1);
		expect(usage.activeMonth).toBe(2);
	});

	it('ranks the most tracked titles and buckets additions by week', async () => {
		const db = createTestDb();
		const now = new Date();
		await db.insert(media).values({ id: 'm-1', type: 'movie', title: 'Popular' });
		await db.insert(media).values({ id: 'm-2', type: 'movie', title: 'Quiet' });
		await db.insert(users).values({ id: 'u-1', email: 'a@example.com', status: 'enabled' });
		await db.insert(users).values({ id: 'u-2', email: 'b@example.com', status: 'enabled' });
		await db.insert(tracking).values({ id: 't-1', userId: 'u-1', mediaId: 'm-1', addedAt: now });
		await db.insert(tracking).values({ id: 't-2', userId: 'u-2', mediaId: 'm-1', addedAt: now });
		await db.insert(tracking).values({ id: 't-3', userId: 'u-1', mediaId: 'm-2', addedAt: now });

		const usage = await countUsage(db, now);

		expect(usage.topTitles.map((entry) => [entry.title, entry.trackers])).toEqual([
			['Popular', 2],
			['Quiet', 1]
		]);
		expect(usage.growth.reduce((total, bucket) => total + bucket.added, 0)).toBe(3);
	});
});
