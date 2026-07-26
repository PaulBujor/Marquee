import { describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/db/test-db';
import { media } from '$lib/server/db/schema';
import { searchLinkedMedia } from './search';

/** Seed a handful of catalog rows: two linked TMDB titles + one private custom entry. */
async function seed(db: Awaited<ReturnType<typeof createTestDb>>) {
	await db.insert(media).values([
		{
			id: 'a',
			provider: 'tmdb',
			externalId: 'movie/603',
			source: 'linked',
			type: 'movie',
			title: 'The Matrix',
			year: 1999,
			posterPath: '/m.jpg'
		},
		{
			id: 'b',
			provider: 'tmdb',
			externalId: 'show/1396',
			source: 'linked',
			type: 'show',
			title: 'Breaking Bad',
			year: 2008,
			posterPath: '/b.jpg'
		},
		{
			id: 'c',
			provider: 'tmdb',
			externalId: null,
			source: 'custom',
			type: 'movie',
			title: 'Matrix home cut',
			year: 2020,
			posterPath: null
		}
	]);
}

describe('searchLinkedMedia', () => {
	it('matches a linked title by case-insensitive substring and maps to a search result', async () => {
		const db = await createTestDb();
		await seed(db);
		const results = await searchLinkedMedia(db, 'matri');
		expect(results).toEqual([
			{
				tmdbId: 603,
				type: 'movie',
				title: 'The Matrix',
				year: 1999,
				posterPath: '/m.jpg',
				overview: ''
			}
		]);
	});

	it('never surfaces private custom entries', async () => {
		const db = await createTestDb();
		await seed(db);
		// "Matrix home cut" is custom — it must not appear even though its title matches.
		const results = await searchLinkedMedia(db, 'matrix');
		expect(results.map((r) => r.title)).toEqual(['The Matrix']);
	});

	it('treats LIKE wildcards in the query as literals', async () => {
		const db = await createTestDb();
		await seed(db);
		// A bare "%" would match everything if unescaped; escaped, it matches no real title.
		expect(await searchLinkedMedia(db, '%')).toEqual([]);
	});

	it('returns nothing for a blank query', async () => {
		const db = await createTestDb();
		await seed(db);
		expect(await searchLinkedMedia(db, '   ')).toEqual([]);
	});
});
