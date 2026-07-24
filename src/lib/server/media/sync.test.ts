import { describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/db/test-db';
import { events, users } from '$lib/server/db/schema';
import { mediaId } from '$lib/sync/events';
import type { MediaDetail } from '$lib/server/tmdb';
import { resolveMediaSync } from './sync';

const USER = 'u1';
const REFERENCED = 'movie/603';
const UNREFERENCED = 'movie/999';

function stub() {
	let calls = 0;
	const getDetails = async (type: 'movie' | 'show', id: number): Promise<MediaDetail> => {
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
			seasons: [],
			lastAired: null
		};
	};
	return { client: { getDetails }, calls: () => calls };
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
		entityId: mediaId('tmdb', REFERENCED),
		payload: { status: 'want_to_watch' },
		deviceId: 'dev',
		schemaVersion: 1,
		clientCreatedAt: 1000,
		serverReceivedAt: new Date()
	});
	return db;
}

describe('resolveMediaSync', () => {
	it('hydrates + returns media the user references, ignoring the rest', async () => {
		const db = await seed();
		const { client, calls } = stub();
		const res = await resolveMediaSync(db, client, USER, {
			refs: [
				{ provider: 'tmdb', externalId: REFERENCED },
				{ provider: 'tmdb', externalId: UNREFERENCED } // not in the user's events
			],
			need: []
		});
		expect(res.media).toHaveLength(1);
		expect(res.media[0]).toMatchObject({ id: mediaId('tmdb', REFERENCED), title: 'title-603' });
		expect(calls()).toBe(1); // only the referenced id was hydrated
	});

	it('returns an already-stored media for a need id with no ref', async () => {
		const db = await seed();
		const { client } = stub();
		// First call stores it via a ref; second call pulls it by need only.
		await resolveMediaSync(db, client, USER, {
			refs: [{ provider: 'tmdb', externalId: REFERENCED }],
			need: []
		});
		const res = await resolveMediaSync(db, client, USER, {
			refs: [],
			need: [mediaId('tmdb', REFERENCED)]
		});
		expect(res.media.map((m) => m.id)).toContain(mediaId('tmdb', REFERENCED));
	});

	it('returns nothing when the request is empty', async () => {
		const db = await seed();
		const { client } = stub();
		const res = await resolveMediaSync(db, client, USER, { refs: [], need: [] });
		expect(res.media).toEqual([]);
	});
});
