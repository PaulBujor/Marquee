/** The local event outbox: enqueue local events, read the unsynced ones, ack pushed ones. */
import { openDb } from './db';
import type { EventEnvelope } from '$lib/sync/events';

/** Add a locally-produced event to the outbox (pending push). */
export async function enqueueEvent(event: EventEnvelope): Promise<void> {
	const db = await openDb();
	await db.put('events', { ...event, synced: 0 });
}

/** All events not yet acknowledged by the server, oldest first. */
export async function getUnsynced(): Promise<EventEnvelope[]> {
	const db = await openDb();
	const rows = await db.getAllFromIndex('events', 'by_synced', 0);
	rows.sort((a, b) => a.clientCreatedAt - b.clientCreatedAt);
	// Return bare envelopes (drop the local `synced` flag) — the wire shape.
	return rows.map((row) => ({
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
	const tx = db.transaction('events', 'readwrite');
	await Promise.all(
		ids.map(async (id) => {
			const row = await tx.store.get(id);
			if (row) {
				row.synced = 1;
				await tx.store.put(row);
			}
		})
	);
	await tx.done;
}
