import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '$lib/server/db/test-db';
import { credits, media, people } from '$lib/server/db/schema';
import { personId } from '$lib/sync/events';
import type { MediaDetail } from '$lib/server/tmdb';
import { creditRowsFromDetail, creditSignature, loadCredits, syncCredits } from './credits';

type Db = ReturnType<typeof createTestDb>;

const MEDIA_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function detail(over: Partial<MediaDetail> = {}): MediaDetail {
	return {
		tmdbId: 27205,
		type: 'movie',
		title: 'Inception',
		year: 2010,
		overview: '',
		posterPath: null,
		backdropPath: null,
		rating: null,
		voteCount: 0,
		runtime: null,
		genres: [],
		cast: [
			{ id: 6193, name: 'Leonardo DiCaprio', character: 'Cobb', profilePath: '/leo.jpg' },
			{ id: 24045, name: 'Joseph Gordon-Levitt', character: 'Arthur', profilePath: null }
		],
		director: { id: 525, name: 'Christopher Nolan' },
		writers: [{ id: 525, name: 'Christopher Nolan' }],
		producers: [{ id: 947, name: 'Emma Thomas' }],
		creators: [],
		trailer: null,
		releaseDate: '2010-07-16',
		status: null,
		inProduction: null,
		firstAirDate: null,
		lastAirDate: null,
		seasons: [],
		similar: [],
		...over
	};
}

async function seedMedia(db: Db) {
	await db.insert(media).values({
		id: MEDIA_ID,
		provider: 'tmdb',
		externalId: 'movie/27205',
		type: 'movie',
		title: 'Inception',
		version: 1,
		refreshedAt: 0
	});
}

let db: Db;
beforeEach(async () => {
	db = createTestDb();
	await seedMedia(db);
});

describe('creditRowsFromDetail', () => {
	it('flattens cast and every crew role, preserving billing order', () => {
		const { personRows, creditRows } = creditRowsFromDetail(MEDIA_ID, detail());
		expect(creditRows.filter((c) => c.role === 'cast').map((c) => c.sortOrder)).toEqual([0, 1]);
		expect(creditRows.find((c) => c.role === 'director')?.personId).toBe(personId('tmdb', 525));
		expect(creditRows.find((c) => c.role === 'producer')?.personId).toBe(personId('tmdb', 947));
		// Nolan is credited twice, in two different roles — legitimate, and both are kept.
		expect(creditRows.filter((c) => c.personId === personId('tmdb', 525))).toHaveLength(2);
		// …but he only produces one `people` row.
		expect(personRows.filter((p) => p.id === personId('tmdb', 525))).toHaveLength(1);
	});

	it('keeps the character for cast and leaves it null for crew', () => {
		const { creditRows } = creditRowsFromDetail(MEDIA_ID, detail());
		expect(creditRows.find((c) => c.role === 'cast')?.character).toBe('Cobb');
		expect(creditRows.find((c) => c.role === 'director')?.character).toBeNull();
	});

	it('collapses a person credited twice in the same role, keeping the first billing', () => {
		const { creditRows } = creditRowsFromDetail(
			MEDIA_ID,
			detail({
				cast: [
					{ id: 1, name: 'Dual Role', character: 'Twin A', profilePath: null },
					{ id: 1, name: 'Dual Role', character: 'Twin B', profilePath: null }
				]
			})
		);
		// `(media, person, role)` is the PK, so only one can persist — keeping the first preserves
		// the order the provider ranked them in.
		const cast = creditRows.filter((c) => c.role === 'cast');
		expect(cast).toHaveLength(1);
		expect(cast[0]).toMatchObject({ character: 'Twin A', sortOrder: 0 });
	});

	it('skips an unnamed person rather than storing a blank credit', () => {
		const { creditRows } = creditRowsFromDetail(
			MEDIA_ID,
			detail({ cast: [{ id: 9, name: '', character: 'Extra', profilePath: null }] })
		);
		expect(creditRows.some((c) => c.role === 'cast')).toBe(false);
	});
});

describe('syncCredits', () => {
	it('stores people once and their credits against the title', async () => {
		const { personRows, creditRows } = creditRowsFromDetail(MEDIA_ID, detail());
		await syncCredits(db, MEDIA_ID, personRows, creditRows);

		expect(await db.select().from(people)).toHaveLength(4); // Leo, JGL, Nolan, Thomas
		expect(await db.select().from(credits).where(eq(credits.mediaId, MEDIA_ID))).toHaveLength(5);
	});

	it('is idempotent — re-running the same detail changes nothing', async () => {
		const { personRows, creditRows } = creditRowsFromDetail(MEDIA_ID, detail());
		await syncCredits(db, MEDIA_ID, personRows, creditRows);
		const before = await db.select().from(credits).where(eq(credits.mediaId, MEDIA_ID));
		await syncCredits(db, MEDIA_ID, personRows, creditRows);
		expect(await db.select().from(credits).where(eq(credits.mediaId, MEDIA_ID))).toEqual(before);
	});

	it('drops a credit that disappeared and adds one that arrived', async () => {
		const first = creditRowsFromDetail(MEDIA_ID, detail());
		await syncCredits(db, MEDIA_ID, first.personRows, first.creditRows);

		const recast = creditRowsFromDetail(
			MEDIA_ID,
			detail({
				cast: [{ id: 6193, name: 'Leonardo DiCaprio', character: 'Cobb', profilePath: '/leo.jpg' }]
			})
		);
		await syncCredits(db, MEDIA_ID, recast.personRows, recast.creditRows);

		const cast = (await db.select().from(credits).where(eq(credits.mediaId, MEDIA_ID))).filter(
			(c) => c.role === 'cast'
		);
		expect(cast).toHaveLength(1);
		expect(cast[0].personId).toBe(personId('tmdb', 6193));
		// The dropped person's row survives — another title may still credit them.
		expect(
			await db
				.select()
				.from(people)
				.where(eq(people.id, personId('tmdb', 24045)))
		).toHaveLength(1);
	});

	it('refreshes a name or photo that changed upstream', async () => {
		const first = creditRowsFromDetail(MEDIA_ID, detail());
		await syncCredits(db, MEDIA_ID, first.personRows, first.creditRows);

		const renamed = creditRowsFromDetail(
			MEDIA_ID,
			detail({
				cast: [{ id: 6193, name: 'Leonardo Di Caprio', character: 'Cobb', profilePath: '/new.jpg' }]
			})
		);
		await syncCredits(db, MEDIA_ID, renamed.personRows, renamed.creditRows);

		const [leo] = await db
			.select()
			.from(people)
			.where(eq(people.id, personId('tmdb', 6193)));
		expect(leo).toMatchObject({ name: 'Leonardo Di Caprio', profilePath: '/new.jpg' });
	});

	it('shares one person row across two titles', async () => {
		const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
		await db.insert(media).values({
			id: other,
			provider: 'tmdb',
			externalId: 'movie/272',
			type: 'movie',
			title: 'Batman Begins',
			version: 1,
			refreshedAt: 0
		});

		const a = creditRowsFromDetail(MEDIA_ID, detail());
		await syncCredits(db, MEDIA_ID, a.personRows, a.creditRows);
		const b = creditRowsFromDetail(other, detail({ cast: [], writers: [], producers: [] }));
		await syncCredits(db, other, b.personRows, b.creditRows);

		// Nolan directed both; one row, two credits — which is the point of the reverse index.
		expect(
			await db
				.select()
				.from(people)
				.where(eq(people.id, personId('tmdb', 525)))
		).toHaveLength(1);
		expect(
			await db
				.select()
				.from(credits)
				.where(eq(credits.personId, personId('tmdb', 525)))
		).toHaveLength(3);
	});
});

describe('creditSignature', () => {
	it('is order-independent but content-sensitive', () => {
		const rows = creditRowsFromDetail(MEDIA_ID, detail()).creditRows;
		expect(creditSignature([...rows].reverse())).toBe(creditSignature(rows));
		expect(creditSignature(rows.slice(1))).not.toBe(creditSignature(rows));
	});
});

describe('loadCredits', () => {
	it('returns wire records joined to their person, ordered by role then billing', async () => {
		const { personRows, creditRows } = creditRowsFromDetail(MEDIA_ID, detail());
		await syncCredits(db, MEDIA_ID, personRows, creditRows);

		const loaded = await loadCredits(db, MEDIA_ID);
		const cast = loaded.filter((c) => c.role === 'cast');
		expect(cast.map((c) => c.name)).toEqual(['Leonardo DiCaprio', 'Joseph Gordon-Levitt']);
		expect(cast[0]).toMatchObject({ character: 'Cobb', profilePath: '/leo.jpg' });
		// Roles group together, so a renderer can section without re-sorting.
		expect(loaded.map((c) => c.role)).toEqual([...loaded.map((c) => c.role)].sort());
	});
});
