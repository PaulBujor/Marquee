import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '$lib/server/db/test-db';
import { episodeWatches, events as eventsTable, tracking, users } from '$lib/server/db/schema';
import {
	mediaId,
	trackingKey,
	type EventEnvelope,
	type EventPayloadMap,
	type SyncEventType
} from '$lib/sync/events';
import { applyEvents, rebuildProjection } from './projection';

type Db = ReturnType<typeof createTestDb>;

const USER = 'user-1';
const DEVICE = '11111111-1111-1111-1111-111111111111';
const MID = mediaId('movie', 603);

let uuidCounter = 0;
function nextUuid(): string {
	uuidCounter += 1;
	return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
}

/** Build an event with an explicit LWW clock (bypasses Date.now for deterministic ordering). */
function ev<T extends SyncEventType>(
	type: T,
	entityId: string,
	payload: EventPayloadMap[T],
	clock: number
): EventEnvelope<T> {
	return {
		id: nextUuid(),
		type,
		entityId,
		payload,
		deviceId: DEVICE,
		clientCreatedAt: clock,
		schemaVersion: 1
	};
}

async function trackingRow(db: Db) {
	const [row] = await db
		.select()
		.from(tracking)
		.where(eq(tracking.id, trackingKey(USER, MID)));
	return row;
}

let db: Db;
beforeEach(async () => {
	db = createTestDb();
	await db.insert(users).values({ id: USER, email: 'u1@x.com', status: 'enabled' });
});

describe('projectEvent via applyEvents', () => {
	it('tracking.added creates the tracking row', async () => {
		await applyEvents(db, USER, [ev('tracking.added', MID, { status: 'watching' }, 100)]);
		const t = await trackingRow(db);
		expect(t).toMatchObject({ status: 'watching', removed: false });
	});

	it('is idempotent — replaying the same event id is a no-op', async () => {
		const e = ev('tracking.added', MID, { status: 'watching' }, 100);
		await applyEvents(db, USER, [e]);
		const applied = await applyEvents(db, USER, [e]);
		expect(applied).toHaveLength(0); // deduped
		expect(await db.select().from(tracking)).toHaveLength(1);
	});

	it('collapses duplicate ids within one push, keeping projection == log', async () => {
		// Two events sharing an id but carrying different payloads. Only one row can persist
		// (composite PK), so exactly one must be projected — else a rebuild would diverge.
		const first = ev('tracking.status_changed', MID, { status: 'watching' }, 100);
		const collidingId = {
			...first,
			payload: { status: 'completed' as const },
			clientCreatedAt: 200
		};
		const applied = await applyEvents(db, USER, [first, collidingId]);
		expect(applied).toHaveLength(1); // second dropped as a dup id
		expect(await db.select().from(eventsTable)).toHaveLength(1);
		expect((await trackingRow(db)).status).toBe('watching'); // first occurrence won

		// The materialized state must equal a replay of the log.
		const before = await trackingRow(db);
		await rebuildProjection(db, USER);
		expect(await trackingRow(db)).toEqual(before);
	});

	it('scopes dedup per user — a colliding id from another user is not dropped', async () => {
		const USER2 = 'user-2';
		await db.insert(users).values({ id: USER2, email: 'u2@x.com', status: 'enabled' });
		// Same event id, different users: the composite (user_id, id) PK keeps them distinct,
		// so a forced/colliding UUID can't drop another user's event.
		const shared = ev('tracking.status_changed', MID, { status: 'watching' }, 100);
		expect(await applyEvents(db, USER, [shared])).toHaveLength(1);
		expect(await applyEvents(db, USER2, [shared])).toHaveLength(1); // not deduped across users
		expect(await db.select().from(eventsTable)).toHaveLength(2);
	});

	it('resolves status by last-write-wins in both arrival orders', async () => {
		// newer (completed@200) must win over older (watching@100) regardless of order.
		await applyEvents(db, USER, [ev('tracking.status_changed', MID, { status: 'completed' }, 200)]);
		await applyEvents(db, USER, [ev('tracking.status_changed', MID, { status: 'watching' }, 100)]);
		expect((await trackingRow(db)).status).toBe('completed');

		const db2 = createTestDb();
		await db2.insert(users).values({ id: USER, email: 'u1@x.com', status: 'enabled' });
		await applyEvents(db2, USER, [ev('tracking.status_changed', MID, { status: 'watching' }, 100)]);
		await applyEvents(db2, USER, [
			ev('tracking.status_changed', MID, { status: 'completed' }, 200)
		]);
		const [t2] = await db2
			.select()
			.from(tracking)
			.where(eq(tracking.id, trackingKey(USER, MID)));
		expect(t2.status).toBe('completed');
	});

	it('favorite is independent of status (per-field clocks)', async () => {
		await applyEvents(db, USER, [ev('tracking.status_changed', MID, { status: 'completed' }, 500)]);
		await applyEvents(db, USER, [ev('tracking.favorite_toggled', MID, { favorite: true }, 100)]);
		const t = await trackingRow(db);
		expect(t.status).toBe('completed'); // not clobbered by the older favorite event
		expect(t.favorite).toBe(true);
	});

	it('rating is an independent LWW field (and clearable)', async () => {
		await applyEvents(db, USER, [ev('tracking.status_changed', MID, { status: 'watching' }, 500)]);
		await applyEvents(db, USER, [ev('tracking.rated', MID, { rating: 4 }, 100)]);
		expect((await trackingRow(db)).rating).toBe(4); // set, independent of status
		await applyEvents(db, USER, [ev('tracking.rated', MID, { rating: null }, 200)]);
		expect((await trackingRow(db)).rating).toBeNull(); // newer null clears it
		expect((await trackingRow(db)).status).toBe('watching'); // status untouched
	});

	it('episode watched/unwatched follows LWW', async () => {
		await applyEvents(db, USER, [ev('episode.watched', MID, { season: 1, episode: 1 }, 200)]);
		await applyEvents(db, USER, [ev('episode.unwatched', MID, { season: 1, episode: 1 }, 100)]);
		const [older] = await db.select().from(episodeWatches);
		expect(older.watched).toBe(true); // older unwatch loses
		await applyEvents(db, USER, [ev('episode.unwatched', MID, { season: 1, episode: 1 }, 300)]);
		const [newer] = await db.select().from(episodeWatches);
		expect(newer.watched).toBe(false); // newer unwatch wins
	});

	it('removed tombstone loses to a later re-add', async () => {
		await applyEvents(db, USER, [ev('tracking.removed', MID, {}, 100)]);
		expect((await trackingRow(db)).removed).toBe(true);
		await applyEvents(db, USER, [ev('tracking.added', MID, { status: 'watching' }, 200)]);
		expect((await trackingRow(db)).removed).toBe(false); // re-add revives
	});

	it('a newer removal is not undone by an older re-add arriving afterward', async () => {
		await applyEvents(db, USER, [ev('tracking.added', MID, { status: 'watching' }, 100)]);
		await applyEvents(db, USER, [ev('tracking.removed', MID, {}, 300)]);
		// A stale re-add (clock 200 < removal 300) arrives later — e.g. a delayed event
		// from another device. The revive is guarded by the removed clock, not status.
		await applyEvents(db, USER, [ev('tracking.added', MID, { status: 'watching' }, 200)]);
		expect((await trackingRow(db)).removed).toBe(true); // removal@300 still wins
	});

	it('rebuildProjection replays the log to the same materialized state', async () => {
		await applyEvents(db, USER, [ev('tracking.added', MID, { status: 'want_to_watch' }, 100)]);
		await applyEvents(db, USER, [ev('tracking.status_changed', MID, { status: 'watching' }, 200)]);
		await applyEvents(db, USER, [ev('episode.watched', MID, { season: 1, episode: 1 }, 300)]);
		await applyEvents(db, USER, [ev('tracking.favorite_toggled', MID, { favorite: true }, 400)]);

		const before = await trackingRow(db);
		const epsBefore = await db.select().from(episodeWatches);

		await rebuildProjection(db, USER);

		const after = await trackingRow(db);
		const epsAfter = await db.select().from(episodeWatches);
		expect(after).toEqual(before);
		expect(epsAfter).toEqual(epsBefore);
	});
});
