import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '$lib/server/db/test-db';
import { sharePreviewWarms, sharePreviews, users } from '$lib/server/db/schema';
import {
	KNOWN_FOR_MAX,
	WARM_MAX_PER_HOUR,
	countRecentWarms,
	previewId,
	purgeSharePreviewWarms,
	readPreview,
	warmPersonPreview,
	warmTitlePreview
} from './preview';

const USER_ID = 'user-1';
const NOW = Date.UTC(2026, 7, 23, 12, 0, 0);

const MOVIE = {
	id: 603,
	title: 'The Matrix',
	release_date: '1999-03-31',
	overview: 'A hacker learns the truth about his reality.',
	poster_path: '/matrix.jpg'
};

function personPayload(creditCount = 10) {
	return {
		id: 287,
		name: 'Brad Pitt',
		biography: 'x'.repeat(900),
		profile_path: '/pitt.jpg',
		combined_credits: {
			cast: Array.from({ length: creditCount }, (_, i) => ({
				id: 2000 + i,
				media_type: 'movie',
				title: `Film ${i}`,
				release_date: `19${String(90 + i).padStart(2, '0')}-01-01`
			}))
		}
	};
}

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

describe('warming a title preview', () => {
	it('stores the catalogue snapshot and returns it', async () => {
		const db = await seedDb();
		stubFetch(MOVIE);

		const result = await warmTitlePreview(db, 'key', {
			userId: USER_ID,
			type: 'movie',
			id: 603,
			now: NOW
		});

		expect(result).toMatchObject({
			kind: 'warmed',
			preview: {
				kind: 'title',
				type: 'movie',
				externalId: 603,
				name: 'The Matrix',
				year: 1999,
				imagePath: '/matrix.jpg'
			}
		});
		const rows = await db.select().from(sharePreviews);
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(previewId('title', 603));
		expect(rows[0].titleType).toBe('movie');
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
			).toEqual({
				kind: 'not_found'
			});
		}
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(await db.select().from(sharePreviews)).toHaveLength(0);
	});

	it('separates an unknown title from a provider failure', async () => {
		const db = await seedDb();
		stubFetch({ status_message: 'not found' }, 404);
		expect(
			await warmTitlePreview(db, 'key', { userId: USER_ID, type: 'movie', id: 1, now: NOW })
		).toEqual({
			kind: 'not_found'
		});

		stubFetch({ status_message: 'boom' }, 500);
		expect(
			await warmTitlePreview(db, 'key', { userId: USER_ID, type: 'movie', id: 1, now: NOW })
		).toEqual({
			kind: 'unavailable'
		});
	});
});

describe('warming a person preview', () => {
	it('keeps only the stub the card needs', async () => {
		const db = await seedDb();
		stubFetch(personPayload());

		const result = await warmPersonPreview(db, 'key', { userId: USER_ID, id: 287, now: NOW });

		expect(result.kind).toBe('warmed');
		if (result.kind !== 'warmed' || result.preview.kind !== 'person')
			throw new Error('wrong shape');
		expect(result.preview.name).toBe('Brad Pitt');
		expect(result.preview.knownFor).toHaveLength(KNOWN_FOR_MAX);
		expect(result.preview.summary).toHaveLength(400);
	});

	it('round-trips the known-for lines through the row', async () => {
		const db = await seedDb();
		stubFetch(personPayload());
		await warmPersonPreview(db, 'key', { userId: USER_ID, id: 287, now: NOW });

		const preview = await readPreview(db, 'person', 287);
		expect(preview?.kind).toBe('person');
		if (preview?.kind !== 'person') throw new Error('wrong shape');
		expect(preview.knownFor[0]).toMatch(/^Film \d+ \(19\d\d\)$/);
	});
});

describe('reading a preview', () => {
	it('never calls the provider — the read path is D1 only', async () => {
		const db = await seedDb();
		stubFetch(MOVIE);
		await warmTitlePreview(db, 'key', { userId: USER_ID, type: 'movie', id: 603, now: NOW });

		// Drop the stub: anything that reached for the network here would throw.
		vi.unstubAllGlobals();
		const preview = await readPreview(db, 'title', 603);
		expect(preview).toMatchObject({ kind: 'title', name: 'The Matrix' });
	});

	it('returns null for anything never warmed, and for an impossible id', async () => {
		const db = await seedDb();
		expect(await readPreview(db, 'title', 603)).toBeNull();
		expect(await readPreview(db, 'person', 0)).toBeNull();
		expect(await readPreview(db, 'person', 1.2)).toBeNull();
	});
});

describe('the per-account cap', () => {
	it('refuses to warm past the hourly cap, and spends no provider call', async () => {
		const db = await seedDb();
		const fetchSpy = stubFetch(MOVIE);
		const rows = Array.from({ length: WARM_MAX_PER_HOUR }, (_, i) => ({
			id: `warm-${i}`,
			userId: USER_ID,
			createdAt: new Date(NOW - 1000)
		}));
		await db.insert(sharePreviewWarms).values(rows);
		expect(await countRecentWarms(db, USER_ID, NOW)).toBe(WARM_MAX_PER_HOUR);

		expect(
			await warmTitlePreview(db, 'key', { userId: USER_ID, type: 'movie', id: 603, now: NOW })
		).toEqual({
			kind: 'rate_limited'
		});
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

	it('counts only the asking account', async () => {
		const db = await seedDb();
		await db.insert(users).values({ id: 'user-2', email: 'other@example.com', status: 'enabled' });
		await db.insert(sharePreviewWarms).values({
			id: 'other-warm',
			userId: 'user-2',
			createdAt: new Date(NOW - 1000)
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
