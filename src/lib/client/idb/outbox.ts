/** The local event outbox: enqueue local events, read the unsynced ones, ack pushed ones. */
import { openDb } from './db';
import type { EventEnvelope } from '$lib/sync/events';

/** Add a locally-produced event to the outbox (pending push). */
export async function enqueueEvent(event: EventEnvelope): Promise<void> {
	const db = await openDb();
	await db.put('events', { ...event, synced: 0 });
}

/**
 * Events not yet acknowledged by the server, oldest first. Pass `limit` to page the
 * outbox — the sync engine (MRQ-43) must keep a push at or under `SYNC_MAX_PUSH`, so
 * a large offline backlog is drained across several round trips rather than one
 * oversized request the server would reject.
 */
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

/** Mark events acknowledged by the server so they stop being pushed. */
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
