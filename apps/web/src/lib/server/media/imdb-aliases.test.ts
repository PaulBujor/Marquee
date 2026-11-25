import { describe, expect, it } from 'vitest';
import { createTestDb } from '#lib/server/db/test-db.js';
import { media, tracking, users } from '#lib/server/db/schema.js';
import { seedMediaId } from '#lib/sync/events.js';
import { createMemoryQueue } from '#lib/server/queue/memory.js';
import { enqueueImdbAliasCandidates, type ImdbAliasMessage } from './imdb-aliases';

type Db = ReturnType<typeof createTestDb>;

/** Insert a bare TMDB row; `imdbCheckedAt` defaults to null (never asked) and `refreshedAt` orders the queue. */
async function seedMedia(
	db: Db,
	externalId: string,
	over: { provider?: 'tmdb' | 'local'; refreshedAt?: number; imdbCheckedAt?: number | null } = {}
) {
	const provider = over.provider ?? 'tmdb';
	const id = provider === 'tmdb' ? seedMediaId('tmdb', externalId) : `local-${externalId}`;
	await db.insert(media).values({
		id,
		provider,
		externalId: provider === 'tmdb' ? externalId : null,
		source: provider === 'tmdb' ? 'linked' : 'custom',
		type: 'movie',
		title: externalId,
		version: 1,
		refreshedAt: over.refreshedAt ?? 0,
		imdbCheckedAt: over.imdbCheckedAt ?? null
	});
	return id;
}

describe('enqueueImdbAliasCandidates', () => {
	it('enqueues one message per hydratable title that has never been asked', async () => {
		const db = createTestDb();
		const id = await seedMedia(db, 'movie/1');
		const queue = createMemoryQueue<ImdbAliasMessage>();

		const result = await enqueueImdbAliasCandidates(db, queue);

		expect(result).toEqual({ scanned: 1, queued: 1, capped: false });
		expect(queue.items).toEqual([{ mediaId: id, provider: 'tmdb', externalId: 'movie/1' }]);
	});

	it('skips a title that was already asked and one it cannot ask TMDB about', async () => {
		const db = createTestDb();
		await seedMedia(db, 'movie/2', { imdbCheckedAt: 1 });
		await seedMedia(db, 'custom-1', { provider: 'local' });
		const queue = createMemoryQueue<ImdbAliasMessage>();

		const result = await enqueueImdbAliasCandidates(db, queue);

		expect(result).toEqual({ scanned: 0, queued: 0, capped: false });
		expect(queue.items).toEqual([]);
	});

	it('stops at the ceiling and reports the overflow instead of draining the catalog', async () => {
		const db = createTestDb();
		await seedMedia(db, 'movie/3', { refreshedAt: 1 });
		await seedMedia(db, 'movie/4', { refreshedAt: 2 });
		await seedMedia(db, 'movie/5', { refreshedAt: 3 });
		const queue = createMemoryQueue<ImdbAliasMessage>();

		const result = await enqueueImdbAliasCandidates(db, queue, 2);

		expect(result).toEqual({ scanned: 3, queued: 2, capped: true });
		expect(queue.items.map((m) => m.externalId)).toEqual(['movie/3', 'movie/4']);
	});

	it('asks tracked titles before untracked ones, then oldest pull first', async () => {
		const db = createTestDb();
		await db.insert(users).values({ id: 'u-1', email: 'a@example.com', status: 'enabled' });
		await seedMedia(db, 'movie/6', { refreshedAt: 1 });
		const trackedNew = await seedMedia(db, 'movie/7', { refreshedAt: 3 });
		await seedMedia(db, 'movie/8', { refreshedAt: 2 });
		await db
			.insert(tracking)
			.values({ id: 'u-1::' + trackedNew, userId: 'u-1', mediaId: trackedNew });
		const queue = createMemoryQueue<ImdbAliasMessage>();

		await enqueueImdbAliasCandidates(db, queue);

		expect(queue.items.map((m) => m.externalId)).toEqual(['movie/7', 'movie/6', 'movie/8']);
	});
});
