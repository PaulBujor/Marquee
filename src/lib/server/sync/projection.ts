/**
 * Server-side projection of the event log into the materialized user-state tables
 * (`tracking`, `episode_watches`). The log is authoritative; those tables are strictly
 * derivable from it (see {@link rebuildProjection}). Media is reference data synced on a
 * separate parallel channel, not through the event log — nothing here touches it.
 *
 * Idempotency and conflict resolution live in SQL: every write is an upsert guarded by
 * `ON CONFLICT DO UPDATE ... WHERE <clock> >= existing`, so re-applying is a no-op and
 * conflicts resolve per **field** last-write-wins keyed by `clientCreatedAt` (epoch ms).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { chunkIds } from '../db/chunk';
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

/** D1 caps statements per batch; chunk well under any plausible limit. */
const BATCH_STATEMENTS = 90;

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
		case 'media.linked':
		case 'media.unlinked':
		case 'media.match_declined': {
			// Media links are resolved on the client. They still travel through the log — that is what
			// carries a link or a dismissal to the user's other devices — but no server read path
			// consults one: the media channel gates on `tracking`, and the notification digest joins
			// `tracking` to `episodes`. So there is nothing to materialize here, and leaving these
			// unprojected keeps the materialized tables exactly derivable by `rebuildProjection`.
			return [];
		}
	}
}

/**
 * Lower a tracking row's `addedAt` to the earliest clock seen for it.
 *
 * `trackingUpsert` can only set `addedAt` on the insert branch — its conflict branch is gated by
 * that field-group's LWW guard, so an event older than the one that created the row updates
 * nothing. That made the server's `addedAt` the clock of whichever event *arrived* first, while
 * the client (`idb/state.ts`) takes the minimum across every event. Two devices adding the same
 * title offline would then disagree permanently, and the value would depend on network arrival
 * order — the one thing LWW is meant to make irrelevant.
 *
 * A plain unguarded `min()` is order-independent and idempotent, so replaying converges. Emitted
 * once per (row, batch) rather than per event: the min over a push's events for a title is known
 * up front, so bulk-marking a 200-episode series adds one statement, not 200.
 *
 * Runs as an UPDATE, not an upsert — the batch always projects the row's events first, so by the
 * time this executes the row exists. `added_at` is a `timestamp` column (Unix *seconds*), while
 * event clocks are epoch ms; convert before comparing.
 */
function addedAtFloor(db: Db, userId: string, entityId: string, clockMs: number): Statement {
	return db
		.update(tracking)
		.set({ addedAt: sql`min(${tracking.addedAt}, ${Math.floor(clockMs / 1000)})` })
		.where(eq(tracking.id, trackingKey(userId, entityId)));
}

/**
 * The earliest clock per tracked entity across `events`, considering only `tracking.*` events —
 * episode events project to `episode_watches` and never create or touch a tracking row, so they
 * are outside `addedAt`'s definition on both sides.
 */
function earliestTrackingClocks(events: ServerEvent[]): Map<string, number> {
	const earliest = new Map<string, number>();
	for (const event of events) {
		if (!event.type.startsWith('tracking.')) continue;
		const current = earliest.get(event.entityId);
		if (current === undefined || event.clientCreatedAt < current) {
			earliest.set(event.entityId, event.clientCreatedAt);
		}
	}
	return earliest;
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
			payload: event.payload,
			deviceId: event.deviceId,
			schemaVersion: event.schemaVersion,
			clientCreatedAt: event.clientCreatedAt,
			serverReceivedAt: new Date(event.serverReceivedAt)
		})
		.onConflictDoNothing();
}

/**
 * Persist a user's incoming events and return them with their server-assigned `sequence`
 * (in `clientCreatedAt` order). Dedup is per-user (PK is `(user_id, id)`): events already
 * stored are dropped up front, and duplicate ids *within* the push are collapsed (first
 * wins) — since only one row per id can persist, projecting a second would desync the
 * materialized state from the log (breaks {@link rebuildProjection}).
 *
 * Each event's log insert and its projection share one batch (chunked for D1 limits), so a
 * mid-way failure can't persist an event without its projection; committed batches are
 * idempotent on retry, and uncommitted events stay unsynced.
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
	for (const ids of chunkIds(unique.map((e) => e.id))) {
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
	// After the rows exist: pull each one's `addedAt` down to the earliest clock in this push.
	for (const [entityId, clock] of earliestTrackingClocks(serverEvents)) {
		if (batch.length >= BATCH_STATEMENTS) await flush();
		batch.push(addedAtFloor(db, userId, entityId, clock));
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
	const replayed: ServerEvent[] = rows.map((row) => ({
		id: row.id,
		userId: row.userId,
		sequence: row.sequence,
		type: row.type,
		entityId: row.entityId,
		payload: row.payload,
		deviceId: row.deviceId,
		clientCreatedAt: row.clientCreatedAt,
		schemaVersion: row.schemaVersion,
		serverReceivedAt: row.serverReceivedAt.getTime()
	}));
	for (const event of replayed) {
		const statements = projectEvent(db, event);
		if (batch.length > 0 && batch.length + statements.length > BATCH_STATEMENTS) await flush();
		batch.push(...statements);
	}
	// Same `addedAt` floor as the live path, so a rebuild reproduces it exactly.
	for (const [entityId, clock] of earliestTrackingClocks(replayed)) {
		if (batch.length >= BATCH_STATEMENTS) await flush();
		batch.push(addedAtFloor(db, userId, entityId, clock));
	}
	await flush();
}
