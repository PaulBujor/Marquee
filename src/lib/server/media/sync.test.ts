import { describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/db/test-db';
import { media, tracking, users } from '$lib/server/db/schema';
import { mediaId } from '$lib/sync/events';
import type { MediaDetail, SeasonDetail } from '$lib/server/tmdb';
import { MEDIA_SYNC_REFRESH_MAX, resolveMediaSync } from './sync';

type Db = ReturnType<typeof createTestDb>;

const USER = 'u1';
const REFERENCED = 'movie/603';
const UNREFERENCED = 'movie/999';
const REF_ID = mediaId('tmdb', REFERENCED);
const T0 = 1_000_000_000_000;

function stub() {
	let calls = 0;
	return {
		calls: () => calls,
		client: {
			async getDetails(type: 'movie' | 'show', id: number): Promise<MediaDetail> {
				calls++;
				return {
					tmdbId: id,
					type,
					title: `title-${id}`,
					year: 1999,
					overview: '',
					posterPath: '/p.jpg',
					backdropPath: '/b.jpg',
					rating: null,
					voteCount: 0,
					runtime: null,
					genres: [],
					cast: [],
					director: null,
					writers: [],
					producers: [],
					creators: [],
					trailer: null,
					releaseDate: '1999-03-31',
					status: null,
					inProduction: null,
					firstAirDate: null,
					lastAirDate: null,
					seasons: [],
					similar: []
				};
			},
			async getSeason(): Promise<SeasonDetail> {
				return { seasonNumber: 0, name: '', episodes: [] };
			}
		}
	};
}

/**
 * Seed a `tracking` row so the user's projection references `externalId` — the anti-abuse source
 * of truth `resolveMediaSync` validates requests against (a stand-in for the real projection a
 * `tracking.added` event would produce; the event log itself is no longer read by this path).
 */
async function addTracking(db: Db, i: number, externalId: string): Promise<void> {
	const id = mediaId('tmdb', externalId);
	await db.insert(tracking).values({
		id: `${USER}::${id}`,
		userId: USER,
		mediaId: id,
		addedAt: new Date(1000 + i),
		updatedAt: new Date(1000 + i)
	});
}

/** Pre-store a fresh, released movie row (so it isn't re-fetched from TMDB). */
async function storeFreshMovie(db: Db, externalId: string, over: Record<string, unknown> = {}) {
	await db.insert(media).values({
		id: mediaId('tmdb', externalId),
		provider: 'tmdb',
		externalId,
		type: 'movie',
		title: `cached-${externalId}`,
		releaseDate: '1999-03-31',
		version: 1,
		refreshedAt: T0,
		...over
	});
}

async function seed() {
	const db = createTestDb();
	await db.insert(users).values({ id: USER, email: 'u1@test.dev', status: 'enabled' });
	// The user tracks REFERENCED (but not UNREFERENCED).
	await addTracking(db, 1, REFERENCED);
	return db;
}

describe('resolveMediaSync', () => {
	it('hydrates + returns media the user references, ignoring unreferenced refs', async () => {
		const db = await seed();
		const { client, calls } = stub();
		const res = await resolveMediaSync(db, client, USER, {
			refs: [
				{ provider: 'tmdb', externalId: REFERENCED },
				{ provider: 'tmdb', externalId: UNREFERENCED } // not in the user's tracking
			],
			have: []
		});
		expect(res.media).toHaveLength(1);
		expect(res.media[0]).toMatchObject({ id: REF_ID, title: 'title-603', version: 1 });
		expect(calls()).toBe(1); // only the referenced id was hydrated
	});

	it('returns a stored row the client reports version 0 for (cross-device catch-up)', async () => {
		const db = await seed();
		const { client } = stub();
		// Device A stores it via a ref.
		await resolveMediaSync(db, client, USER, {
			refs: [{ provider: 'tmdb', externalId: REFERENCED }],
			have: []
		});
		// Device B has the tracking row but no local copy — it asks by reporting version 0.
		const res = await resolveMediaSync(db, client, USER, {
			refs: [],
			have: [{ id: REF_ID, version: 0 }]
		});
		expect(res.media.map((m) => m.id)).toContain(REF_ID);
	});

	it('ignores an id the request never asked about, even if referenced', async () => {
		const db = await seed();
		const { client } = stub();
		await resolveMediaSync(db, client, USER, {
			refs: [{ provider: 'tmdb', externalId: REFERENCED }],
			have: []
		});
		// Empty request → nothing returned, even though the user still references REF_ID. The
		// client is expected to ask (via `have`) when it wants a version-diff.
		const res = await resolveMediaSync(db, client, USER, { refs: [], have: [] });
		expect(res.media).toEqual([]);
	});

	it('omits a row the client already has at the current version (version-diff)', async () => {
		const db = await seed();
		const { client } = stub();
		await resolveMediaSync(db, client, USER, {
			refs: [{ provider: 'tmdb', externalId: REFERENCED }],
			have: []
		});
		// Client reports it has version 1 → nothing to send back.
		const upToDate = await resolveMediaSync(db, client, USER, {
			refs: [],
			have: [{ id: REF_ID, version: 1 }]
		});
		expect(upToDate.media).toEqual([]);
		// Client behind (version 0) → the row is returned.
		const behind = await resolveMediaSync(db, client, USER, {
			refs: [],
			have: [{ id: REF_ID, version: 0 }]
		});
		expect(behind.media.map((m) => m.id)).toEqual([REF_ID]);
	});

	it('returns nothing when the request is empty', async () => {
		const db = createTestDb();
		await db.insert(users).values({ id: USER, email: 'u1@test.dev', status: 'enabled' });
		const { client } = stub();
		const res = await resolveMediaSync(db, client, USER, { refs: [], have: [] });
		expect(res.media).toEqual([]);
	});

	it('skips a fresh stored row — no TMDB fetch', async () => {
		const db = await seed();
		await storeFreshMovie(db, REFERENCED);
		const { client, calls } = stub();
		const res = await resolveMediaSync(
			db,
			client,
			USER,
			{ refs: [{ provider: 'tmdb', externalId: REFERENCED }], have: [{ id: REF_ID, version: 0 }] },
			T0
		);
		expect(calls()).toBe(0); // already stored → not re-fetched (missing-only hydration)
		expect(res.media.map((m) => m.id)).toEqual([REF_ID]); // still returned (client reported 0)
		expect(res.pending).toBe(false);
	});

	it("does not re-hydrate an existing row past its airing TTL — that is the cron's job now", async () => {
		const db = createTestDb();
		await db.insert(users).values({ id: USER, email: 'u1@test.dev', status: 'enabled' });
		const ext = 'show/1396';
		await addTracking(db, 1, ext);
		await db.insert(media).values({
			id: mediaId('tmdb', ext),
			provider: 'tmdb',
			externalId: ext,
			type: 'show',
			title: 'old',
			status: 'Returning Series',
			inProduction: true,
			version: 1,
			refreshedAt: T0 - 13 * 3600_000 // >12h ago → past the airing TTL, but already stored
		});
		const { client, calls } = stub();
		const res = await resolveMediaSync(
			db,
			client,
			USER,
			{
				refs: [{ provider: 'tmdb', externalId: ext }],
				have: [{ id: mediaId('tmdb', ext), version: 1 }]
			},
			T0
		);
		expect(calls()).toBe(0); // request-time sync never re-pulls an existing row, TTL or not
		expect(res.media).toEqual([]); // client already reports the current version
		expect(res.pending).toBe(false);
	});

	it('caps hydration per request and drains the rest via `pending`', async () => {
		const db = createTestDb();
		await db.insert(users).values({ id: USER, email: 'u1@test.dev', status: 'enabled' });
		const total = MEDIA_SYNC_REFRESH_MAX + 5;
		const refs: { provider: 'tmdb'; externalId: string }[] = [];
		for (let i = 0; i < total; i++) {
			const ext = `movie/${2000 + i}`;
			await addTracking(db, i, ext);
			refs.push({ provider: 'tmdb', externalId: ext });
		}
		const { client, calls } = stub();

		// First pass hydrates only up to the cap and flags there's more to do.
		const first = await resolveMediaSync(db, client, USER, { refs, have: [] }, T0);
		expect(calls()).toBe(MEDIA_SYNC_REFRESH_MAX);
		expect(first.pending).toBe(true);
		expect(first.media).toHaveLength(MEDIA_SYNC_REFRESH_MAX);

		// Second pass: the first batch is now stored, so only the remainder is hydrated.
		const second = await resolveMediaSync(db, client, USER, { refs, have: [] }, T0);
		expect(calls()).toBe(total); // the remaining 5, no re-fetch of the first 25
		expect(second.pending).toBe(false);
		expect(new Set(second.media.map((m) => m.id)).size).toBe(total); // all present now
	});

	it('returns a large stored library across chunked IN queries', async () => {
		// More stored titles than the 90-id chunk (and than D1's 100-param cap), so the media
		// `IN (...)` query must be split — otherwise D1 throws "too many SQL variables".
		const db = createTestDb();
		await db.insert(users).values({ id: USER, email: 'u1@test.dev', status: 'enabled' });
		const N = 205;
		const have: { id: string; version: number }[] = [];
		for (let i = 0; i < N; i++) {
			const ext = `movie/${1000 + i}`;
			await addTracking(db, i, ext);
			await storeFreshMovie(db, ext, { title: `t-${i}` });
			have.push({ id: mediaId('tmdb', ext), version: 0 });
		}
		const { client, calls } = stub();
		const res = await resolveMediaSync(db, client, USER, { refs: [], have }, T0);
		expect(calls()).toBe(0);
		expect(res.media).toHaveLength(N);
		expect(new Set(res.media.map((m) => m.id)).size).toBe(N);
	});
});
