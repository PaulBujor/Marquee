import { openDb } from './db';
import type { EventEnvelope } from '#lib/sync/events.js';

export async function enqueueEvent(event: EventEnvelope): Promise<void> {
	const db = await openDb();
	await db.put('events', { ...event, synced: 0 });
}

/** An import seeds thousands of events; per-event transactions would be thousands of them. */
export async function enqueueEvents(events: EventEnvelope[]): Promise<void> {
	if (events.length === 0) return;
	const db = await openDb();
	const transaction = db.transaction('events', 'readwrite');
	await Promise.all(events.map((event) => transaction.store.put({ ...event, synced: 0 })));
	await transaction.done;
}

/** `limit` must keep a push at or under `SYNC_MAX_PUSH` — the server rejects an oversized one. */
export async function getUnsynced(limit?: number): Promise<EventEnvelope[]> {
	const db = await openDb();
	const rows = await db.getAllFromIndex('events', 'by_synced', 0);
	rows.sort((a, b) => a.clientCreatedAt - b.clientCreatedAt);
	const page = limit === undefined ? rows : rows.slice(0, limit);
	// Return bare envelopes (drop the local `synced` flag) — the wire shape.
	return page.map((row) => ({
		id: row.id,
		type: row.type,
		entityId: row.entityId,
		payload: row.payload,
		deviceId: row.deviceId,
		clientCreatedAt: row.clientCreatedAt,
		schemaVersion: row.schemaVersion
	}));
}

export async function markSynced(ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	const db = await openDb();
	const transaction = db.transaction('events', 'readwrite');
	await Promise.all(
		ids.map(async (id) => {
			const row = await transaction.store.get(id);
			if (row) {
				row.synced = 1;
				await transaction.store.put(row);
			}
		})
	);
	await transaction.done;
}
