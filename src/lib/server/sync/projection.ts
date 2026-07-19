/**
 * Server-side projection of the event log into the materialized tables
 * (`media`, `tracking`, `episode_watches`). The log is authoritative; these
 * tables are strictly derivable from it (see {@link rebuildProjection}).
 *
 * Idempotency and conflict resolution are pushed **into SQL**: every projection
 * write is an upsert guarded by `... ON CONFLICT DO UPDATE SET ... WHERE <clock> >=
 * existing`, so re-applying an event is a no-op, an older event loses, and a newer
 * one wins — with no read-before-write. Conflicts resolve per-field **last-write-
 * wins** keyed by the event's `clientCreatedAt` (epoch ms).
 */
import { eq, inArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
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

/** Build the materialized-table upserts for a single (server-augmented) event. */
export function projectEvent(db: Db, ev: ServerEvent): Statement[] {
	const clock = ev.clientCreatedAt;
	const mid = ev.entityId;
	const tkey = trackingKey(ev.userId, mid);

	switch (ev.type) {
		case 'media.tracked': {
			const p = ev.payload as EventPayloadMap['media.tracked'];
			return [
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
				db
					.insert(tracking)
					.values({
						id: tkey,
						userId: ev.userId,
						mediaId: mid,
						status: p.status,
						removed: false,
						statusUpdatedAt: clock,
						removedUpdatedAt: clock,
						addedAt: new Date(clock),
						updatedAt: new Date(clock)
					})
					.onConflictDoUpdate({
						target: tracking.id,
						// Re-adding a title revives it and (re)asserts its status, but only
						// if this event is at least as new as the last status change.
						set: {
							status: p.status,
							statusUpdatedAt: clock,
							removed: false,
							removedUpdatedAt: clock,
							updatedAt: new Date(clock)
						},
						setWhere: sql`${clock} >= ${tracking.statusUpdatedAt}`
					})
			];
		}
		case 'tracking.status_changed': {
			const p = ev.payload as EventPayloadMap['tracking.status_changed'];
			return [
				db
					.insert(tracking)
					.values({
						id: tkey,
						userId: ev.userId,
						mediaId: mid,
						status: p.status,
						statusUpdatedAt: clock,
						addedAt: new Date(clock),
						updatedAt: new Date(clock)
					})
					.onConflictDoUpdate({
						target: tracking.id,
						set: { status: p.status, statusUpdatedAt: clock, updatedAt: new Date(clock) },
						setWhere: sql`${clock} >= ${tracking.statusUpdatedAt}`
					})
			];
		}
		case 'tracking.favorite_toggled': {
			const p = ev.payload as EventPayloadMap['tracking.favorite_toggled'];
			return [
				db
					.insert(tracking)
					.values({
						id: tkey,
						userId: ev.userId,
						mediaId: mid,
						favorite: p.favorite,
						favoriteUpdatedAt: clock,
						addedAt: new Date(clock),
						updatedAt: new Date(clock)
					})
					.onConflictDoUpdate({
						target: tracking.id,
						set: { favorite: p.favorite, favoriteUpdatedAt: clock, updatedAt: new Date(clock) },
						setWhere: sql`${clock} >= ${tracking.favoriteUpdatedAt}`
					})
			];
		}
		case 'tracking.removed': {
			return [
				db
					.insert(tracking)
					.values({
						id: tkey,
						userId: ev.userId,
						mediaId: mid,
						removed: true,
						removedUpdatedAt: clock,
						addedAt: new Date(clock),
						updatedAt: new Date(clock)
					})
					.onConflictDoUpdate({
						target: tracking.id,
						set: { removed: true, removedUpdatedAt: clock, updatedAt: new Date(clock) },
						setWhere: sql`${clock} >= ${tracking.removedUpdatedAt}`
					})
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

/**
 * Persist a batch of client events for a user and return them augmented with the
 * server-assigned `seq` (in `clientCreatedAt` order). Already-seen events (by id)
 * are dropped up front; the `events` insert is also `ON CONFLICT DO NOTHING` as a
 * belt-and-suspenders guard against a racing duplicate. The event inserts and all
 * projection upserts run in one atomic `db.batch()`.
 */
export async function applyEvents(
	db: Db,
	userId: string,
	incoming: EventEnvelope[]
): Promise<ServerEvent[]> {
	if (incoming.length === 0) return [];

	const ids = incoming.map((e) => e.id);
	const existing = await db
		.select({ id: eventsTable.id })
		.from(eventsTable)
		.where(inArray(eventsTable.id, ids));
	const seen = new Set(existing.map((r) => r.id));
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

	const statements: Statement[] = [];
	for (const ev of server) {
		statements.push(
			db
				.insert(eventsTable)
				.values({
					id: ev.id,
					userId,
					seq: ev.seq,
					type: ev.type,
					entityId: ev.entityId,
					payload: JSON.stringify(ev.payload),
					deviceId: ev.deviceId,
					schemaVersion: ev.schemaVersion,
					clientCreatedAt: ev.clientCreatedAt,
					serverReceivedAt: new Date(ev.serverReceivedAt)
				})
				.onConflictDoNothing() as Statement
		);
		statements.push(...projectEvent(db, ev));
	}
	await runBatch(db, statements);
	return server;
}

/**
 * Recovery / test oracle: drop a user's materialized rows and rebuild them by
 * replaying the event log in `seq` order. The global `media` cache is left intact
 * (it's shared and derivable from every user's `media.tracked` events).
 */
export async function rebuildProjection(db: Db, userId: string): Promise<void> {
	await db.delete(tracking).where(eq(tracking.userId, userId));
	await db.delete(episodeWatches).where(eq(episodeWatches.userId, userId));

	const rows = await db
		.select()
		.from(eventsTable)
		.where(eq(eventsTable.userId, userId))
		.orderBy(eventsTable.seq);

	const statements: Statement[] = [];
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
		statements.push(...projectEvent(db, ev));
	}
	if (statements.length > 0) await runBatch(db, statements);
}
