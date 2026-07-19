/**
 * Server-side projection of the event log into the materialized tables
 * (`media`, `tracking`, `episode_watches`). The log is authoritative; these
 * tables are strictly derivable from it (see {@link rebuildProjection}).
 *
 * Idempotency and conflict resolution are pushed **into SQL**: every projection
 * write is an upsert guarded by `... ON CONFLICT DO UPDATE SET ... WHERE <clock> >=
 * existing`, so re-applying an event is a no-op, an older event loses, and a newer
 * one wins — with no read-before-write. Conflicts resolve per **field** last-write-
 * wins keyed by the event's `clientCreatedAt` (epoch ms): each field carries its own
 * clock, so e.g. a stale re-add can't revive a title a newer removal tombstoned.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { createDb } from '../db';
import { episodeWatches, events as eventsTable, media, syncState, tracking } from '../db/schema';
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
async function reserveSeqBlock(db: Db, userId: string, count: number): Promise<number> {
	const [row] = await db
		.insert(syncState)
		.values({ userId, lastSeq: count })
		.onConflictDoUpdate({
			target: syncState.userId,
			set: { lastSeq: sql`${syncState.lastSeq} + ${count}` }
		})
		.returning({ lastSeq: syncState.lastSeq });
	return row.lastSeq;
}

/**
 * Upsert one field-group of a user's tracking row under an LWW guard on `clockCol`.
 * `fields` seeds a fresh row (insert branch) and is the winning update (conflict
 * branch); `updatedAt` is bookkeeping and always refreshed.
 */
function trackingUpsert(
	db: Db,
	ev: ServerEvent,
	fields: TrackingFields,
	clockCol: SQLiteColumn
): Statement {
	const clock = ev.clientCreatedAt;
	const tkey = trackingKey(ev.userId, ev.entityId);
	return db
		.insert(tracking)
		.values({
			id: tkey,
			userId: ev.userId,
			mediaId: ev.entityId,
			addedAt: new Date(clock),
			updatedAt: new Date(clock),
			...fields
		})
		.onConflictDoUpdate({
			target: tracking.id,
			set: { ...fields, updatedAt: new Date(clock) },
			setWhere: sql`${clock} >= ${clockCol}`
		});
}

/** Build the materialized-table upserts for a single (server-augmented) event. */
export function projectEvent(db: Db, ev: ServerEvent): Statement[] {
	const clock = ev.clientCreatedAt;
	const mid = ev.entityId;

	switch (ev.type) {
		case 'tracking.added': {
			const p = ev.payload as EventPayloadMap['tracking.added'];
			return [
				// Catalog cache (its own clock).
				db
					.insert(media)
					.values({
						id: mid,
						tmdbId: p.media.tmdbId,
						type: p.media.type,
						title: p.media.title,
						year: p.media.year,
						posterPath: p.media.posterPath,
						overview: p.media.overview,
						updatedAt: clock
					})
					.onConflictDoUpdate({
						target: media.id,
						set: {
							title: p.media.title,
							year: p.media.year,
							posterPath: p.media.posterPath,
							overview: p.media.overview,
							updatedAt: clock
						},
						setWhere: sql`${clock} >= ${media.updatedAt}`
					}),
				// Assert the status (status clock) and revive from any tombstone (removed
				// clock) as two independent LWW fields — so a stale add can't un-remove a
				// title that a newer removal deleted.
				trackingUpsert(
					db,
					ev,
					{ status: p.status, statusUpdatedAt: clock },
					tracking.statusUpdatedAt
				),
				trackingUpsert(
					db,
					ev,
					{ removed: false, removedUpdatedAt: clock },
					tracking.removedUpdatedAt
				)
			];
		}
		case 'tracking.status_changed': {
			const p = ev.payload as EventPayloadMap['tracking.status_changed'];
			return [
				trackingUpsert(
					db,
					ev,
					{ status: p.status, statusUpdatedAt: clock },
					tracking.statusUpdatedAt
				)
			];
		}
		case 'tracking.favorite_toggled': {
			const p = ev.payload as EventPayloadMap['tracking.favorite_toggled'];
			return [
				trackingUpsert(
					db,
					ev,
					{ favorite: p.favorite, favoriteUpdatedAt: clock },
					tracking.favoriteUpdatedAt
				)
			];
		}
		case 'tracking.removed': {
			return [
				trackingUpsert(
					db,
					ev,
					{ removed: true, removedUpdatedAt: clock },
					tracking.removedUpdatedAt
				)
			];
		}
		case 'episode.watched':
		case 'episode.unwatched': {
			const p = ev.payload as EventPayloadMap['episode.watched'];
			const watched = ev.type === 'episode.watched';
			const ekey = episodeKey(ev.userId, mid, p.season, p.episode);
			return [
				db
					.insert(episodeWatches)
					.values({
						id: ekey,
						userId: ev.userId,
						mediaId: mid,
						season: p.season,
						episode: p.episode,
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

/** The append-only log insert for one event (dedup by client uuid PK). */
function insertEventStmt(db: Db, ev: ServerEvent): Statement {
	return db
		.insert(eventsTable)
		.values({
			id: ev.id,
			userId: ev.userId,
			seq: ev.seq,
			type: ev.type,
			entityId: ev.entityId,
			payload: JSON.stringify(ev.payload),
			deviceId: ev.deviceId,
			schemaVersion: ev.schemaVersion,
			clientCreatedAt: ev.clientCreatedAt,
			serverReceivedAt: new Date(ev.serverReceivedAt)
		})
		.onConflictDoNothing();
}

/**
 * Persist a batch of client events for a user and return them augmented with the
 * server-assigned `seq` (in `clientCreatedAt` order). Already-seen events (by id)
 * are dropped up front; the log insert is also `ON CONFLICT DO NOTHING` to absorb a
 * racing duplicate.
 *
 * Writes are chunked to respect D1's per-batch limits, but each event's log insert
 * and its projection stay in the **same** batch — so a mid-way failure can never
 * leave a persisted event whose projection was skipped (dedup would then never
 * re-apply it). A failed batch throws; earlier batches are already committed and
 * safe to re-receive (idempotent), later events stay unsynced and get retried.
 */
export async function applyEvents(
	db: Db,
	userId: string,
	incoming: EventEnvelope[]
): Promise<ServerEvent[]> {
	if (incoming.length === 0) return [];

	// Dedup, chunked to stay under D1's bound-parameter limit.
	const seen = new Set<string>();
	for (const ids of chunk(
		incoming.map((e) => e.id),
		DEDUP_CHUNK
	)) {
		const rows = await db
			.select({ id: eventsTable.id })
			.from(eventsTable)
			.where(inArray(eventsTable.id, ids));
		for (const r of rows) seen.add(r.id);
	}
	const fresh = incoming.filter((e) => !seen.has(e.id));
	if (fresh.length === 0) return [];

	// Assign seq in causal (clientCreatedAt) order.
	fresh.sort((a, b) => a.clientCreatedAt - b.clientCreatedAt);
	const highWater = await reserveSeqBlock(db, userId, fresh.length);
	const start = highWater - fresh.length + 1;
	const receivedAt = Date.now();

	const server: ServerEvent[] = fresh.map((e, i) => ({
		...e,
		userId,
		seq: start + i,
		serverReceivedAt: receivedAt
	}));

	let batch: Statement[] = [];
	const flush = async () => {
		if (batch.length > 0) {
			await runBatch(db, batch);
			batch = [];
		}
	};
	for (const ev of server) {
		const stmts = [insertEventStmt(db, ev), ...projectEvent(db, ev)];
		if (batch.length > 0 && batch.length + stmts.length > BATCH_STATEMENTS) await flush();
		batch.push(...stmts);
	}
	await flush();

	return server;
}

/**
 * Recovery / test oracle: drop a user's materialized rows and rebuild them by
 * replaying the event log in `seq` order. The global `media` cache is left intact
 * (it's shared and derivable from every user's `tracking.added` events).
 */
export async function rebuildProjection(db: Db, userId: string): Promise<void> {
	await db.delete(tracking).where(eq(tracking.userId, userId));
	await db.delete(episodeWatches).where(eq(episodeWatches.userId, userId));

	const rows = await db
		.select()
		.from(eventsTable)
		.where(eq(eventsTable.userId, userId))
		.orderBy(eventsTable.seq);

	let batch: Statement[] = [];
	const flush = async () => {
		if (batch.length > 0) {
			await runBatch(db, batch);
			batch = [];
		}
	};
	for (const row of rows) {
		const ev: ServerEvent = {
			id: row.id,
			userId: row.userId,
			seq: row.seq,
			type: row.type,
			entityId: row.entityId,
			payload: JSON.parse(row.payload),
			deviceId: row.deviceId,
			clientCreatedAt: row.clientCreatedAt,
			schemaVersion: row.schemaVersion,
			serverReceivedAt: row.serverReceivedAt.getTime()
		};
		const stmts = projectEvent(db, ev);
		if (batch.length > 0 && batch.length + stmts.length > BATCH_STATEMENTS) await flush();
		batch.push(...stmts);
	}
	await flush();
}
