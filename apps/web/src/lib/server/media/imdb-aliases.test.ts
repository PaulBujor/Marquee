import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '#lib/server/db/test-db.js';
import { media, mediaExternalIds, tracking, users } from '#lib/server/db/schema.js';
import { seedMediaId } from '#lib/sync/events.js';
import { backfillImdbAliases } from './imdb-aliases';

type Db = ReturnType<typeof createTestDb>;

const T0 = Date.UTC(2026, 6, 24);

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

describe('backfillImdbAliases', () => {
	it('writes the alias and stamps when TMDB returns an IMDb id', async () => {
		const db = createTestDb();
		const id = await seedMedia(db, 'movie/1');

		const result = await backfillImdbAliases(db, { externalIds: async () => 'tt0000001' }, T0);

		expect(result).toEqual({ scanned: 1, aliased: 1, noId: 0, failed: 0, capped: false });
		const [row] = await db.select().from(media).where(eq(media.id, id));
		expect(row.imdbCheckedAt).toBe(T0);
		const aliases = await db
			.select()
			.from(mediaExternalIds)
			.where(eq(mediaExternalIds.mediaId, id));
		expect(aliases).toEqual([{ mediaId: id, provider: 'imdb', externalId: 'tt0000001' }]);
	});

	it('stamps without aliasing when TMDB answers with no IMDb id', async () => {
		const db = createTestDb();
		const id = await seedMedia(db, 'movie/2');

		const result = await backfillImdbAliases(db, { externalIds: async () => null }, T0);

		expect(result).toEqual({ scanned: 1, aliased: 0, noId: 1, failed: 0, capped: false });
		const [row] = await db.select().from(media).where(eq(media.id, id));
		expect(row.imdbCheckedAt).toBe(T0);
		expect(await db.select().from(mediaExternalIds)).toEqual([]);
	});

	it('leaves a failed title unstamped and still processes the rest of the batch', async () => {
		const db = createTestDb();
		const failing = await seedMedia(db, 'movie/3', { refreshedAt: 1 });
		const ok = await seedMedia(db, 'movie/4', { refreshedAt: 2 });

		let call = 0;
		const result = await backfillImdbAliases(
			db,
			{
				async externalIds() {
					call++;
					if (call === 1) throw new Error('TMDB responded 429');
					return 'tt0000004';
				}
			},
			T0
		);

		expect(result).toEqual({ scanned: 2, aliased: 1, noId: 0, failed: 1, capped: false });
		const rows = await db.select().from(media);
		const byId = new Map(rows.map((r) => [r.id, r]));
		expect(byId.get(failing)?.imdbCheckedAt).toBeNull();
		expect(byId.get(ok)?.imdbCheckedAt).toBe(T0);
	});

	it('limits the batch to the ceiling and reports the overflow', async () => {
		const db = createTestDb();
		await seedMedia(db, 'movie/5', { refreshedAt: 1 });
		await seedMedia(db, 'movie/6', { refreshedAt: 2 });
		await seedMedia(db, 'movie/7', { refreshedAt: 3 });

		const result = await backfillImdbAliases(db, { externalIds: async () => null }, T0, 2);

		expect(result).toMatchObject({ scanned: 2, capped: true });
		const stamped = (await db.select().from(media)).filter((r) => r.imdbCheckedAt !== null);
		expect(stamped).toHaveLength(2);
	});

	it('never selects a row it cannot ask TMDB about', async () => {
		const db = createTestDb();
		const custom = await seedMedia(db, 'custom-1', { provider: 'local' });
		let asked = 0;

		const result = await backfillImdbAliases(
			db,
			{
				async externalIds() {
					asked++;
					return 'tt0000008';
				}
			},
			T0
		);

		expect(result).toEqual({ scanned: 0, aliased: 0, noId: 0, failed: 0, capped: false });
		expect(asked).toBe(0);
		const [row] = await db.select().from(media).where(eq(media.id, custom));
		expect(row.imdbCheckedAt).toBeNull();
	});

	it('asks tracked titles before untracked ones, then oldest pull first', async () => {
		const db = createTestDb();
		await db.insert(users).values({ id: 'u-1', email: 'a@example.com', status: 'enabled' });
		await seedMedia(db, 'movie/9', { refreshedAt: 1 });
		const trackedNew = await seedMedia(db, 'movie/10', { refreshedAt: 3 });
		await seedMedia(db, 'movie/11', { refreshedAt: 2 });
		await db
			.insert(tracking)
			.values({ id: 'u-1::' + trackedNew, userId: 'u-1', mediaId: trackedNew });

		const asked: string[] = [];
		await backfillImdbAliases(
			db,
			{
				async externalIds(_type, id) {
					asked.push(String(id));
					return null;
				}
			},
			T0
		);

		// The TMDB id doubles as the record of call order: tracked 10 first, then 9 and 11 oldest-first.
		expect(asked).toEqual(['10', '9', '11']);
	});
});
