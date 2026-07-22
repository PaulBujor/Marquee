/**
 * Server-side projection of the event log into the materialized user-state tables
 * (`tracking`, `episode_watches`). The log is authoritative; those tables are strictly
 * derivable from it (see {@link rebuildProjection}). Media is reference data synced on a
 * separate parallel channel (MRQ-111), not through the event log — nothing here touches it.
 *
 * Idempotency and conflict resolution live in SQL: every write is an upsert guarded by
 * `ON CONFLICT DO UPDATE ... WHERE <clock> >= existing`, so re-applying is a no-op and
 * conflicts resolve per **field** last-write-wins keyed by `clientCreatedAt` (epoch ms).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { createDb } from '../db';
import { episodeWatches, events as eventsTable, syncState, tracking } from '../db/schema';
import {
	episodeKey,
	trackingKey,
	type EventEnvelope,
	type EventPayloadMap,
	type ServerEvent
} from '$lib/sync/events';

type Db = ReturnType<typeof createDb>;
/** A runnable SQLite query that can be handed to `db.batch()`. */
type Statement = BatchItem<'sqlite'>;
type TrackingFields = Partial<typeof tracking.$inferInsert>;

/**
 * D1 caps bound parameters per query and statements per batch. Chunk well under any
 * plausible limit: dedup `IN (...)` lists and projection batches are split accordingly.
 */
const DEDUP_CHUNK = 90;
const BATCH_STATEMENTS = 90;

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/** Drizzle's `batch` wants a non-empty tuple type; at runtime it takes an array. */
function runBatch(db: Db, statements: Statement[]): Promise<unknown[]> {
	return db.batch(statements as unknown as [Statement, ...Statement[]]);
}

/**
 * Atomically reserve a contiguous block of `count` sequence numbers for a user.
 * A single upsert-with-RETURNING is serialized by SQLite, so concurrent Worker
 * invocations receive disjoint blocks. Returns the new high-water mark; the
 * caller owns `[highWater - count + 1 .. highWater]`.
 */
async function reserveSequenceBlock(db: Db, userId: string, count: number): Promise<number> {
	const [row] = await db
		.insert(syncState)
		.values({ userId, lastSequence: count })
		.onConflictDoUpdate({
			target: syncState.userId,
			set: { lastSequence: sql`${syncState.lastSequence} + ${count}` }
		})
		.returning({ lastSequence: syncState.lastSequence });
	return row.lastSequence;
}

/**
 * Upsert one field-group of a user's tracking row under an LWW guard on `clockColumn`.
 * `fields` seeds a fresh row (insert branch) and is the winning update (conflict branch).
 */
function trackingUpsert(
	db: Db,
	event: ServerEvent,
	fields: TrackingFields,
	clockColumn: SQLiteColumn
): Statement {
	const clock = event.clientCreatedAt;
	const trackingId = trackingKey(event.userId, event.entityId);
	return db
		.insert(tracking)
		.values({
			id: trackingId,
			userId: event.userId,
			mediaId: event.entityId,
			addedAt: new Date(clock),
			updatedAt: new Date(clock),
			...fields
		})
		.onConflictDoUpdate({
			target: tracking.id,
			set: { ...fields, updatedAt: new Date(clock) },
			setWhere: sql`${clock} >= ${clockColumn}`
		});
}

/** Build the materialized user-state upserts for a single (server-augmented) event. */
export function projectEvent(db: Db, event: ServerEvent): Statement[] {
	const clock = event.clientCreatedAt;

	switch (event.type) {
		case 'tracking.added': {
			const payload = event.payload as EventPayloadMap['tracking.added'];
			// An add asserts the tracking entry: set the status and revive from any tombstone
			// as two independent LWW fields, so a stale add can't un-remove a title a newer
			// removal deleted. (Media is reference data, handled off the event log.)
			return [
				trackingUpsert(
					db,
					event,
					{ status: payload.status, statusUpdatedAt: clock },
					tracking.statusUpdatedAt
				),
				trackingUpsert(
					db,
					event,
					{ removed: false, removedUpdatedAt: clock },
					tracking.removedUpdatedAt
				)
			];
		}
		case 'tracking.status_changed': {
			const payload = event.payload as EventPayloadMap['tracking.status_changed'];
			return [
				trackingUpsert(
					db,
					event,
					{ status: payload.status, statusUpdatedAt: clock },
					tracking.statusUpdatedAt
				)
			];
		}
		case 'tracking.favorite_toggled': {
			const payload = event.payload as EventPayloadMap['tracking.favorite_toggled'];
			return [
				trackingUpsert(
					db,
					event,
					{ favorite: payload.favorite, favoriteUpdatedAt: clock },
					tracking.favoriteUpdatedAt
				)
			];
		}
		case 'tracking.rated': {
			const payload = event.payload as EventPayloadMap['tracking.rated'];
			return [
				trackingUpsert(
					db,
					event,
					{ rating: payload.rating, ratingUpdatedAt: clock },
					tracking.ratingUpdatedAt
				)
			];
		}
		case 'tracking.removed': {
			return [
				trackingUpsert(
					db,
					event,
					{ removed: true, removedUpdatedAt: clock },
					tracking.removedUpdatedAt
				)
			];
		}
		case 'episode.watched':
		case 'episode.unwatched': {
			const payload = event.payload as EventPayloadMap['episode.watched'];
			const watched = event.type === 'episode.watched';
			const episodeId = episodeKey(event.userId, event.entityId, payload.season, payload.episode);
			return [
				db
					.insert(episodeWatches)
					.values({
						id: episodeId,
						userId: event.userId,
						mediaId: event.entityId,
						season: payload.season,
						episode: payload.episode,
						watched,
						updatedAt: clock
					})
					.onConflictDoUpdate({
						target: episodeWatches.id,
						set: { watched, updatedAt: clock },
						setWhere: sql`${clock} >= ${episodeWatches.updatedAt}`
					})
			];
		}
	}
}

/** The append-only log insert for one event (dedup by the composite `(user_id, id)` PK). */
function insertEventStatement(db: Db, event: ServerEvent): Statement {
	return db
		.insert(eventsTable)
		.values({
			id: event.id,
			userId: event.userId,
			sequence: event.sequence,
			type: event.type,
			entityId: event.entityId,
			payload: JSON.stringify(event.payload),
			deviceId: event.deviceId,
			schemaVersion: event.schemaVersion,
			clientCreatedAt: event.clientCreatedAt,
			serverReceivedAt: new Date(event.serverReceivedAt)
		})
		.onConflictDoNothing();
}

/**
 * Persist a batch of client events for a user and return them augmented with the
 * server-assigned `sequence` (in `clientCreatedAt` order). Already-seen events (by id,
 * scoped to this user) are dropped up front; the log insert is also `ON CONFLICT DO
 * NOTHING` to absorb a race. Dedup is per-user because the events PK is `(user_id, id)`.
 *
 * Duplicate ids *within* the push are also collapsed (first occurrence wins) before any
 * write: only one row per id can ever persist (composite PK), so projecting more than one
 * event for the same id would let the materialized state disagree with the log — breaking
 * the {@link rebuildProjection} invariant. Collapsing keeps projection and log in lockstep.
 *
 * Writes are chunked for D1's per-batch limits, but each event's log insert and its
 * projection stay in the **same** batch — so a mid-way failure can't leave a persisted
 * event whose projection was skipped. Earlier batches are already committed and safe to
 * re-receive (idempotent); later events stay unsynced and get retried.
 */
export async function applyEvents(
	db: Db,
	userId: string,
	incoming: EventEnvelope[]
): Promise<ServerEvent[]> {
	if (incoming.length === 0) return [];

	// Collapse duplicate ids within this push (keep first occurrence) — see the doc note.
	const byId = new Map<string, EventEnvelope>();
	for (const e of incoming) if (!byId.has(e.id)) byId.set(e.id, e);
	const unique = [...byId.values()];

	// Dedup within this user's events (PK is composite), chunked for D1's param limit.
	const seen = new Set<string>();
	for (const ids of chunk(
		unique.map((e) => e.id),
		DEDUP_CHUNK
	)) {
		const rows = await db
			.select({ id: eventsTable.id })
			.from(eventsTable)
			.where(and(eq(eventsTable.userId, userId), inArray(eventsTable.id, ids)));
		for (const row of rows) seen.add(row.id);
	}
	const fresh = unique.filter((e) => !seen.has(e.id));
	if (fresh.length === 0) return [];

	// Assign sequence in causal (clientCreatedAt) order.
	fresh.sort((a, b) => a.clientCreatedAt - b.clientCreatedAt);
	const highWater = await reserveSequenceBlock(db, userId, fresh.length);
	const start = highWater - fresh.length + 1;
	const receivedAt = Date.now();

	const serverEvents: ServerEvent[] = fresh.map((e, i) => ({
		...e,
		userId,
		sequence: start + i,
		serverReceivedAt: receivedAt
	}));

	let batch: Statement[] = [];
	const flush = async () => {
		if (batch.length > 0) {
			await runBatch(db, batch);
			batch = [];
		}
	};
	for (const event of serverEvents) {
		const statements = [insertEventStatement(db, event), ...projectEvent(db, event)];
		if (batch.length > 0 && batch.length + statements.length > BATCH_STATEMENTS) await flush();
		batch.push(...statements);
	}
	await flush();

	return serverEvents;
}

/**
 * Recovery / test oracle: drop a user's materialized rows and rebuild them by replaying
 * the event log in `sequence` order. Media is reference data (not derived from the log),
 * so it's untouched by a rebuild.
 */
export async function rebuildProjection(db: Db, userId: string): Promise<void> {
	await db.delete(tracking).where(eq(tracking.userId, userId));
	await db.delete(episodeWatches).where(eq(episodeWatches.userId, userId));

	const rows = await db
		.select()
		.from(eventsTable)
		.where(eq(eventsTable.userId, userId))
		.orderBy(eventsTable.sequence);

	let batch: Statement[] = [];
	const flush = async () => {
		if (batch.length > 0) {
			await runBatch(db, batch);
			batch = [];
		}
	};
	for (const row of rows) {
		const event: ServerEvent = {
			id: row.id,
			userId: row.userId,
			sequence: row.sequence,
			type: row.type,
			entityId: row.entityId,
			payload: JSON.parse(row.payload),
			deviceId: row.deviceId,
			clientCreatedAt: row.clientCreatedAt,
			schemaVersion: row.schemaVersion,
			serverReceivedAt: row.serverReceivedAt.getTime()
		};
		const statements = projectEvent(db, event);
		if (batch.length > 0 && batch.length + statements.length > BATCH_STATEMENTS) await flush();
		batch.push(...statements);
	}
	await flush();
}
