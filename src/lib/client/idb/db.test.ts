import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { createEvent } from '$lib/sync/events';
import { openDb, setActiveUser, type OutboxEvent } from './db';

const DEVICE = '11111111-1111-1111-1111-111111111111';

describe('openDb upgrade', () => {
	it('preserves pending outbox events when upgrading an older database', async () => {
		const user = 'db-upgrade-user';
		const name = `marquee-${user}`;

		// Simulate a pre-existing v1 database that only had the events outbox (before the
		// mediaImages store was added at v2).
		const v1 = await openDB(name, 1, {
			upgrade(db) {
				const events = db.createObjectStore('events', { keyPath: 'id' });
				events.createIndex('by_synced', 'synced');
				events.createIndex('by_clientCreatedAt', 'clientCreatedAt');
			}
		});
		const pending: OutboxEvent = {
			...createEvent('tracking.added', 'agg-1', { status: 'watching' }, DEVICE),
			synced: 0
		};
		await v1.put('events', pending);
		v1.close();

		// Opening at the current version runs the additive upgrade for every later version.
		setActiveUser(user);
		const db = await openDb();

		expect(await db.get('events', pending.id)).toMatchObject({ id: pending.id, synced: 0 });
		expect(db.objectStoreNames.contains('mediaImages')).toBe(true); // upgrade did run
	});

	it('adds the mediaLinks store to a database created before it existed', async () => {
		const user = 'db-upgrade-links-user';
		const name = `marquee-${user}`;

		// A v3 database: everything the store held before media links were introduced.
		const v3 = await openDB(name, 3, {
			upgrade(db) {
				db.createObjectStore('events', { keyPath: 'id' }).createIndex('by_synced', 'synced');
				db.createObjectStore('tracking', { keyPath: 'mediaId' });
				db.createObjectStore('media', { keyPath: 'id' });
				db.createObjectStore('seasons', { keyPath: 'id' });
				db.createObjectStore('episodes', { keyPath: 'id' });
				db.createObjectStore('mediaImages', { keyPath: 'id' });
				db.createObjectStore('episodeWatches', { keyPath: 'id' });
				db.createObjectStore('meta', { keyPath: 'key' });
			}
		});
		await v3.put('tracking', {
			mediaId: 'keep-me',
			status: 'watching',
			favorite: false,
			rating: null,
			removed: false,
			statusUpdatedAt: 1,
			favoriteUpdatedAt: 0,
			ratingUpdatedAt: 0,
			removedUpdatedAt: 0,
			addedAt: 1
		});
		v3.close();

		setActiveUser(user);
		const db = await openDb();

		expect(db.objectStoreNames.contains('mediaLinks')).toBe(true);
		// The upgrade is additive — existing projections survive it.
		expect(await db.get('tracking', 'keep-me')).toMatchObject({ status: 'watching' });
	});

	it('adds the credits store to a database created before it existed', async () => {
		const user = 'db-upgrade-credits-user';
		const name = `marquee-${user}`;

		// A v4 database: everything the store held before cast and crew were cached.
		const v4 = await openDB(name, 4, {
			upgrade(db) {
				db.createObjectStore('events', { keyPath: 'id' }).createIndex('by_synced', 'synced');
				db.createObjectStore('tracking', { keyPath: 'mediaId' });
				db.createObjectStore('media', { keyPath: 'id' });
				db.createObjectStore('seasons', { keyPath: 'id' });
				db.createObjectStore('episodes', { keyPath: 'id' });
				db.createObjectStore('mediaImages', { keyPath: 'id' });
				db.createObjectStore('mediaLinks', { keyPath: 'mediaId' });
				db.createObjectStore('episodeWatches', { keyPath: 'id' });
				db.createObjectStore('meta', { keyPath: 'key' });
			}
		});
		await v4.put('media', { id: 'keep-me', title: 'Cached Before Credits', version: 3 });
		v4.close();

		setActiveUser(user);
		const db = await openDb();

		expect(db.objectStoreNames.contains('credits')).toBe(true);
		// A cached title predating the store has no credits, not a broken read — the media channel
		// backfills them on the next version diff.
		expect(await db.getAllFromIndex('credits', 'by_media', 'keep-me')).toEqual([]);
		expect(await db.get('media', 'keep-me')).toMatchObject({ title: 'Cached Before Credits' });
	});
});
