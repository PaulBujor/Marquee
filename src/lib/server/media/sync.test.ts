import { describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/db/test-db';
import { events, users } from '$lib/server/db/schema';
import { mediaId } from '$lib/sync/events';
import type { MediaDetail, SeasonDetail } from '$lib/server/tmdb';
import { resolveMediaSync } from './sync';

const USER = 'u1';
const REFERENCED = 'movie/603';
const UNREFERENCED = 'movie/999';
const REF_ID = mediaId('tmdb', REFERENCED);

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
					trailer: null,
					releaseDate: '1999-03-31',
					status: null,
					inProduction: null,
					firstAirDate: null,
					lastAirDate: null,
					seasons: []
				};
			},
			async getSeason(): Promise<SeasonDetail> {
				return { seasonNumber: 0, name: '', episodes: [] };
			}
		}
	};
}

async function seed() {
	const db = createTestDb();
	await db.insert(users).values({ id: USER, email: 'u1@test.dev', status: 'enabled' });
	// The user has an event referencing REFERENCED (but not UNREFERENCED).
	await db.insert(events).values({
		id: 'ev1',
		userId: USER,
		sequence: 1,
		type: 'tracking.added',
		entityId: REF_ID,
		payload: { status: 'want_to_watch' },
		deviceId: 'dev',
		schemaVersion: 1,
		clientCreatedAt: 1000,
		serverReceivedAt: new Date()
	});
	return db;
}

describe('resolveMediaSync', () => {
	it('hydrates + returns media the user references, ignoring unreferenced refs', async () => {
		const db = await seed();
		const { client, calls } = stub();
		const res = await resolveMediaSync(db, client, USER, {
			refs: [
				{ provider: 'tmdb', externalId: REFERENCED },
				{ provider: 'tmdb', externalId: UNREFERENCED } // not in the user's events
			],
			have: []
		});
		expect(res.media).toHaveLength(1);
		expect(res.media[0]).toMatchObject({ id: REF_ID, title: 'title-603', version: 1 });
		expect(calls()).toBe(1); // only the referenced id was hydrated
	});

	it('returns a stored row the client is missing, even with no ref (cross-device)', async () => {
		const db = await seed();
		const { client } = stub();
		// Device A stores it via a ref.
		await resolveMediaSync(db, client, USER, {
			refs: [{ provider: 'tmdb', externalId: REFERENCED }],
			have: []
		});
		// Device B has the event but no media + no identity ref — still gets the stored row.
		const res = await resolveMediaSync(db, client, USER, { refs: [], have: [] });
		expect(res.media.map((m) => m.id)).toContain(REF_ID);
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

	it('returns nothing when the user references no media', async () => {
		const db = createTestDb();
		await db.insert(users).values({ id: USER, email: 'u1@test.dev', status: 'enabled' });
		const { client } = stub();
		const res = await resolveMediaSync(db, client, USER, { refs: [], have: [] });
		expect(res.media).toEqual([]);
	});
});
