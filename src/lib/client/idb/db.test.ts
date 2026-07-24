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

		// Opening at the current version runs the additive upgrade to v2.
		setActiveUser(user);
		const db = await openDb();

		expect(await db.get('events', pending.id)).toMatchObject({ id: pending.id, synced: 0 });
		expect(db.objectStoreNames.contains('mediaImages')).toBe(true); // upgrade did run
	});
});
