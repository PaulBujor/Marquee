import { describe, expect, it } from 'vitest';
import { createTestDb } from '#lib/server/db/test-db.js';
import { media, mediaExternalIds } from '#lib/server/db/schema.js';
import { seedMediaId } from '#lib/sync/events.js';
import { resolveMediaId, writeExternalId } from './external-ids';

type Db = ReturnType<typeof createTestDb>;

/** A stored provider-backed title, with the primary alias the migration's backfill gives every existing row. */
async function seedMedia(db: Db, externalId: string): Promise<string> {
	const id = seedMediaId('tmdb', externalId);
	await db.insert(media).values({ id, externalId, type: 'movie', title: externalId });
	await writeExternalId(db, id, 'tmdb', externalId);
	return id;
}

describe('resolveMediaId', () => {
	it('resolves a stored alias', async () => {
		const db = createTestDb();
		const id = await seedMedia(db, 'movie/603');
		await writeExternalId(db, id, 'imdb', 'tt0133093');

		expect(await resolveMediaId(db, 'tmdb', 'movie/603')).toBe(id);
		expect(await resolveMediaId(db, 'imdb', 'tt0133093')).toBe(id);
	});

	it('returns null for an external id nothing names', async () => {
		const db = createTestDb();
		await seedMedia(db, 'movie/603');

		expect(await resolveMediaId(db, 'imdb', 'tt0133093')).toBeNull();
	});

	it('does not mint an id for an external id nothing names', async () => {
		const db = createTestDb();

		expect(await resolveMediaId(db, 'tmdb', 'movie/603')).toBeNull();
		// Not the derived id either, and no alias written on the way to finding that out.
		expect(await resolveMediaId(db, 'tmdb', 'movie/603')).not.toBe(
			seedMediaId('tmdb', 'movie/603')
		);
		expect(await db.select().from(mediaExternalIds)).toEqual([]);
		expect(await db.select().from(media)).toEqual([]);
	});
});

describe('writeExternalId', () => {
	it('writing the same alias twice leaves one row', async () => {
		const db = createTestDb();
		const id = await seedMedia(db, 'movie/603');

		await writeExternalId(db, id, 'imdb', 'tt0133093');
		await writeExternalId(db, id, 'imdb', 'tt0133093');

		const aliases = await db.select().from(mediaExternalIds);
		expect(aliases.filter((alias) => alias.provider === 'imdb')).toEqual([
			{ mediaId: id, provider: 'imdb', externalId: 'tt0133093' }
		]);
	});

	it('leaves the first title in place when a second write claims its external id', async () => {
		const db = createTestDb();
		const first = await seedMedia(db, 'movie/603');
		const second = await seedMedia(db, 'movie/604');

		await writeExternalId(db, first, 'imdb', 'tt0133093');
		await writeExternalId(db, second, 'imdb', 'tt0133093');

		expect(await resolveMediaId(db, 'imdb', 'tt0133093')).toBe(first);
		// The unique index is what enforces one title per external id, not the helper's tolerance.
		await expect(
			db
				.insert(mediaExternalIds)
				.values({ mediaId: second, provider: 'imdb', externalId: 'tt0133093' })
		).rejects.toThrow();
	});
});
