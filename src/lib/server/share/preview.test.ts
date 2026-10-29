import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '$lib/server/db/test-db';
import { sharePreviewWarms, sharePreviews, users } from '$lib/server/db/schema';
import {
	WARM_MAX_PER_HOUR,
	countRecentWarms,
	previewId,
	purgeSharePreviewWarms,
	purgeSharePreviews,
	readPreview,
	warmTitlePreview
} from './preview';

const USER_ID = 'user-1';
const NOW = Date.UTC(2026, 7, 23, 12, 0, 0);

/** A TMDB movie detail, with the fields the snapshot keeps. */
const MOVIE = {
	id: 603,
	title: 'The Matrix',
	release_date: '1999-03-31',
	overview: 'A hacker learns the truth about his reality.',
	poster_path: '/matrix.jpg',
	backdrop_path: '/matrix-backdrop.jpg',
	vote_average: 8.2,
	runtime: 136,
	genres: [
		{ id: 28, name: 'Action' },
		{ id: 878, name: 'Science Fiction' }
	],
	credits: {
		cast: Array.from({ length: 20 }, (_, i) => ({
			id: 100 + i,
			name: `Actor ${i}`,
			character: `Role ${i}`,
			profile_path: `/actor-${i}.jpg`
		})),
		crew: [
			{ id: 1, name: 'Lana Wachowski', job: 'Director' },
			{ id: 2, name: 'Lilly Wachowski', job: 'Writer' },
			{ id: 3, name: 'Joel Silver', job: 'Producer' }
		]
	}
};

/** A TMDB show detail: production state, first air date, per-episode runtime. */
const SHOW = {
	id: 1399,
	name: 'Game of Thrones',
	first_air_date: '2011-04-17',
	overview: 'Noble families vie for the throne.',
	poster_path: '/got.jpg',
	backdrop_path: '/got-backdrop.jpg',
	vote_average: 8.4,
	episode_run_time: [57],
	in_production: true,
	genres: [{ id: 10765, name: 'Sci-Fi & Fantasy' }],
	created_by: [{ id: 9, name: 'David Benioff' }],
	seasons: [
		{ season_number: 0, name: 'Specials', episode_count: 3 },
		{ season_number: 1, name: 'Season 1', episode_count: 10 },
		{ season_number: 2, name: 'Season 2', episode_count: 10 }
	],
	credits: { cast: [], crew: [] }
};

function stubFetch(body: unknown, status = 200) {
	const spy = vi.fn(async () => new Response(JSON.stringify(body), { status }));
	vi.stubGlobal('fetch', spy);
	return spy;
}

async function seedDb() {
	const db = createTestDb();
	await db.insert(users).values({ id: USER_ID, email: 'sharer@example.com', status: 'enabled' });
	return db;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('warming a preview', () => {
	it('snapshots the whole title page, not just a card', async () => {
		const db = await seedDb();
		stubFetch(MOVIE);

		const result = await warmTitlePreview(db, 'key', {
			userId: USER_ID,
			type: 'movie',
			id: 603,
			now: NOW
		});

		expect(result.kind).toBe('warmed');
		if (result.kind !== 'warmed') throw new Error('wrong shape');
		expect(result.preview).toMatchObject({
			type: 'movie',
			externalId: 603,
			name: 'The Matrix',
			year: 1999,
			imagePath: '/matrix.jpg',
			backdropPath: '/matrix-backdrop.jpg',
			rating: 8.2,
			runtime: 136,
			releasedOn: '1999-03-31',
			production: null,
			genres: ['Action', 'Science Fiction'],
			crew: {
				director: 'Lana Wachowski',
				creators: [],
				writers: ['Lilly Wachowski'],
				producers: ['Joel Silver']
			}
		});
		// The TMDB client caps cast at ten; the snapshot carries exactly what the page shows.
		expect(result.preview.cast).toHaveLength(10);
		expect(result.preview.cast[0]).toEqual({ name: 'Actor 0', profilePath: '/actor-0.jpg' });
		// Cast faces carry no id: the shared page shows them, it never links to a person.
		expect(Object.keys(result.preview.cast[0])).toEqual(['name', 'profilePath']);
	});

	it('reads a show as a show — first air date, per-episode runtime, production badge', async () => {
		const db = await seedDb();
		stubFetch(SHOW);

		const result = await warmTitlePreview(db, 'key', {
			userId: USER_ID,
			type: 'show',
			id: 1399,
			now: NOW
		});

		if (result.kind !== 'warmed') throw new Error('wrong shape');
		expect(result.preview).toMatchObject({
			type: 'show',
			releasedOn: '2011-04-17',
			runtime: 57,
			// Two real seasons; the Specials season doesn't count.
			seasons: 2,
			production: 'in_production',
			crew: { director: null, creators: ['David Benioff'] }
		});
	});

	it('round-trips every field through the row', async () => {
		const db = await seedDb();
		stubFetch(MOVIE);
		await warmTitlePreview(db, 'key', { userId: USER_ID, type: 'movie', id: 603, now: NOW });

		const stored = await db.select().from(sharePreviews);
		expect(stored[0].id).toBe(previewId(603));
		expect(stored[0].titleType).toBe('movie');

		const preview = await readPreview(db, 603);
		expect(preview).toMatchObject({
			name: 'The Matrix',
			rating: 8.2,
			runtime: 136,
			releasedOn: '1999-03-31',
			genres: ['Action', 'Science Fiction'],
			crew: { director: 'Lana Wachowski' }
		});
		expect(preview?.cast).toHaveLength(10);
	});

	it('is idempotent — re-warming refreshes the same row', async () => {
		const db = await seedDb();
		stubFetch(MOVIE);
		await warmTitlePreview(db, 'key', { userId: USER_ID, type: 'movie', id: 603, now: NOW });

		stubFetch({ ...MOVIE, title: 'The Matrix (remastered)' });
		await warmTitlePreview(db, 'key', { userId: USER_ID, type: 'movie', id: 603, now: NOW + 1000 });

		const rows = await db.select().from(sharePreviews);
		expect(rows).toHaveLength(1);
		expect(rows[0].name).toBe('The Matrix (remastered)');
	});

	it('rejects ids that could not name a real title, without calling the provider', async () => {
		const db = await seedDb();
		const fetchSpy = stubFetch(MOVIE);

		for (const id of [0, -5, 1.5, Number.NaN]) {
			expect(
				await warmTitlePreview(db, 'key', { userId: USER_ID, type: 'movie', id, now: NOW })
			).toEqual({ kind: 'not_found' });
		}
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(await db.select().from(sharePreviews)).toHaveLength(0);
	});

	it('separates an unknown title from a provider failure', async () => {
		const db = await seedDb();
		stubFetch({ status_message: 'not found' }, 404);
		expect(
			await warmTitlePreview(db, 'key', { userId: USER_ID, type: 'movie', id: 1, now: NOW })
		).toEqual({ kind: 'not_found' });

		stubFetch({ status_message: 'boom' }, 500);
		expect(
			await warmTitlePreview(db, 'key', { userId: USER_ID, type: 'movie', id: 1, now: NOW })
		).toEqual({ kind: 'unavailable' });
	});

	it('counts the attempt even when the provider fails, so an outage is not free retries', async () => {
		const db = await seedDb();
		stubFetch({ status_message: 'boom' }, 500);

		expect(
			await warmTitlePreview(db, 'key', { userId: USER_ID, type: 'movie', id: 603, now: NOW })
		).toEqual({ kind: 'unavailable' });
		expect(await countRecentWarms(db, USER_ID, NOW)).toBe(1);
	});

	it('records the warm against the asking account only', async () => {
		const db = await seedDb();
		stubFetch(MOVIE);
		await warmTitlePreview(db, 'key', { userId: USER_ID, type: 'movie', id: 603, now: NOW });

		expect(await countRecentWarms(db, USER_ID, NOW)).toBe(1);
		expect(await countRecentWarms(db, 'someone-else', NOW)).toBe(0);
	});
});

describe('reading a preview', () => {
	it('never calls the provider — the read path is D1 only', async () => {
		const db = await seedDb();
		stubFetch(MOVIE);
		await warmTitlePreview(db, 'key', { userId: USER_ID, type: 'movie', id: 603, now: NOW });

		// Drop the stub: anything that reached for the network here would throw.
		vi.unstubAllGlobals();
		const preview = await readPreview(db, 603);
		expect(preview).toMatchObject({ name: 'The Matrix' });
	});

	it('returns null for anything never warmed, and for an impossible id', async () => {
		const db = await seedDb();
		expect(await readPreview(db, 603)).toBeNull();
		expect(await readPreview(db, 0)).toBeNull();
		expect(await readPreview(db, 1.2)).toBeNull();
	});
});

describe('the per-account cap', () => {
	it('refuses to warm past the hourly cap, and spends no provider call', async () => {
		const db = await seedDb();
		const fetchSpy = stubFetch(MOVIE);
		await db.insert(sharePreviewWarms).values(
			Array.from({ length: WARM_MAX_PER_HOUR }, (_, i) => ({
				id: `warm-${i}`,
				userId: USER_ID,
				createdAt: new Date(NOW - 1000)
			}))
		);

		expect(
			await warmTitlePreview(db, 'key', { userId: USER_ID, type: 'movie', id: 603, now: NOW })
		).toEqual({ kind: 'rate_limited' });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('forgets warms once they fall outside the window', async () => {
		const db = await seedDb();
		await db.insert(sharePreviewWarms).values({
			id: 'old-warm',
			userId: USER_ID,
			createdAt: new Date(NOW - 2 * 60 * 60 * 1000)
		});
		expect(await countRecentWarms(db, USER_ID, NOW)).toBe(0);
	});
});

describe('purging warm rows', () => {
	it('drops rows past retention and keeps fresh ones', async () => {
		const db = await seedDb();
		await db.insert(sharePreviewWarms).values([
			{ id: 'stale', userId: USER_ID, createdAt: new Date(NOW - 48 * 60 * 60 * 1000) },
			{ id: 'fresh', userId: USER_ID, createdAt: new Date(NOW - 60 * 1000) }
		]);

		expect(await purgeSharePreviewWarms(db, NOW)).toBe(1);
		const remaining = await db
			.select()
			.from(sharePreviewWarms)
			.where(eq(sharePreviewWarms.userId, USER_ID));
		expect(remaining.map((row) => row.id)).toEqual(['fresh']);
	});
});

describe('purging previews', () => {
	it('evicts a preview nobody has refreshed inside the retention window', async () => {
		const db = await seedDb();
		const day = 24 * 60 * 60 * 1000;
		await db.insert(sharePreviews).values([
			{
				id: previewId(1),
				provider: 'tmdb',
				externalId: '1',
				titleType: 'movie',
				name: 'Forgotten',
				updatedAt: new Date(NOW - 100 * day)
			},
			{
				id: previewId(2),
				provider: 'tmdb',
				externalId: '2',
				titleType: 'movie',
				name: 'Recent',
				updatedAt: new Date(NOW - 1 * day)
			}
		]);

		expect(await purgeSharePreviews(db, NOW)).toBe(1);
		const remaining = await db.select().from(sharePreviews);
		expect(remaining.map((row) => row.name)).toEqual(['Recent']);
	});
});
