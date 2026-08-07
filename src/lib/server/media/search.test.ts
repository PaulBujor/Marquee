import { describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/db/test-db';
import { media, seasons } from '$lib/server/db/schema';
import { enrichWithLinkedData, searchLinkedMedia } from './search';
import type { MediaSearchResult } from '$lib/server/tmdb';

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
			titleNormalized: 'the matrix',
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
			titleNormalized: 'breaking bad',
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
			titleNormalized: 'matrix home cut',
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

	it('returns results ordered by most recently updated first', async () => {
		const db = await createTestDb();
		// Seed two matching rows with different updatedAt timestamps.
		await db.insert(media).values([
			{
				id: 'old',
				provider: 'tmdb',
				externalId: 'movie/100',
				source: 'linked',
				type: 'movie',
				title: 'Alpha',
				titleNormalized: 'alpha',
				year: 2000,
				updatedAt: 1000
			},
			{
				id: 'new',
				provider: 'tmdb',
				externalId: 'movie/200',
				source: 'linked',
				type: 'movie',
				title: 'Alpha Returns',
				titleNormalized: 'alpha returns',
				year: 2010,
				updatedAt: 5000
			}
		]);
		const results = await searchLinkedMedia(db, 'alpha');
		expect(results.map((r) => r.tmdbId)).toEqual([200, 100]);
	});

	it('includes season count (excluding Specials) for shows, not movies', async () => {
		const db = await createTestDb();
		await seed(db);
		await db.insert(media).values({
			id: 'd',
			provider: 'tmdb',
			externalId: 'show/999',
			source: 'linked',
			type: 'show',
			title: 'Better Call Saul',
			titleNormalized: 'better call saul',
			year: 2015,
			inProduction: false
		});
		await db.insert(seasons).values([
			{ mediaId: 'd', seasonNumber: 0, episodeCount: 1 }, // Specials — excluded from the count
			{ mediaId: 'd', seasonNumber: 1, episodeCount: 10 },
			{ mediaId: 'd', seasonNumber: 2, episodeCount: 10 }
		]);

		const [show] = await searchLinkedMedia(db, 'better call saul');
		expect(show).toMatchObject({ numberOfSeasons: 2 });

		const [movie] = await searchLinkedMedia(db, 'the matrix');
		expect(movie.numberOfSeasons).toBeUndefined();
	});

	it('folds non-ASCII case like the offline client (matches accented titles)', async () => {
		const db = await createTestDb();
		// `title_normalized` holds the JS `toLowerCase()` fold (what refreshMedia writes), so an
		// uppercase accented query matches — where SQLite's ASCII-only LIKE on `title` would not (MRQ-141).
		await db.insert(media).values({
			id: 'ete',
			provider: 'tmdb',
			externalId: 'movie/900',
			source: 'linked',
			type: 'movie',
			title: 'ÉTÉ',
			titleNormalized: 'ÉTÉ'.toLowerCase(),
			year: 2016
		});
		expect((await searchLinkedMedia(db, 'été')).map((r) => r.title)).toEqual(['ÉTÉ']);
		expect((await searchLinkedMedia(db, 'ÉTÉ')).map((r) => r.title)).toEqual(['ÉTÉ']);
	});
});

describe('enrichWithLinkedData', () => {
	/** A bare TMDB multi-search-shaped result, before any enrichment. */
	function tmdbResult(over: Partial<MediaSearchResult> & Pick<MediaSearchResult, 'type'>) {
		return { tmdbId: 1, title: 'Title', year: 2020, posterPath: null, overview: '', ...over };
	}

	it('fills in season count for a show we already hold linked', async () => {
		const db = await createTestDb();
		await db.insert(media).values({
			id: 'saul',
			provider: 'tmdb',
			externalId: 'show/1396',
			source: 'linked',
			type: 'show',
			title: 'Breaking Bad',
			titleNormalized: 'breaking bad',
			year: 2008,
			inProduction: false
		});
		await db.insert(seasons).values([
			{ mediaId: 'saul', seasonNumber: 0, episodeCount: 1 }, // Specials — excluded
			{ mediaId: 'saul', seasonNumber: 1, episodeCount: 7 }
		]);

		const raw = [tmdbResult({ tmdbId: 1396, type: 'show', title: 'Breaking Bad' })];
		const enriched = await enrichWithLinkedData(db, raw);
		expect(enriched).toEqual([expect.objectContaining({ tmdbId: 1396, numberOfSeasons: 1 })]);
	});

	it('leaves a show unchanged when we have no linked copy of it', async () => {
		const db = await createTestDb();
		const raw = [tmdbResult({ tmdbId: 42, type: 'show' })];
		expect(await enrichWithLinkedData(db, raw)).toEqual(raw);
	});

	it('never touches movie results', async () => {
		const db = await createTestDb();
		const raw = [tmdbResult({ tmdbId: 603, type: 'movie' })];
		expect(await enrichWithLinkedData(db, raw)).toEqual(raw);
	});

	it('is a no-op for an empty result set', async () => {
		const db = await createTestDb();
		expect(await enrichWithLinkedData(db, [])).toEqual([]);
	});
});
