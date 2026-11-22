// The event log is authoritative; `media.deleted` is the one media write in it, and every write is a per-field LWW upsert keyed by `clientCreatedAt`.
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { chunkIds } from '../db/chunk';
import type { createDb } from '../db';
import { episodeWatches, events as eventsTable, media, syncState, tracking } from '../db/schema';
import {
	episodeKey,
	trackingKey,
	type EventEnvelope,
	type EventPayloadMap,
	type ServerEvent
} from '#lib/sync/events.js';

type Db = ReturnType<typeof createDb>;
type Statement = BatchItem<'sqlite'>;
type TrackingFields = Partial<typeof tracking.$inferInsert>;

/** D1 caps statements per batch; chunk well under any plausible limit. */
const BATCH_STATEMENTS = 90;

/** Drizzle's `batch` wants a non-empty tuple type; at runtime it takes an array. */
function runBatch(db: Db, statements: Statement[]): Promise<unknown[]> {
	return db.batch(statements as unknown as [Statement, ...Statement[]]);
}

// One upsert-with-RETURNING, serialized by SQLite, so concurrent Worker invocations get disjoint blocks.
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

export function projectEvent(db: Db, event: ServerEvent): Statement[] {
	const clock = event.clientCreatedAt;

	switch (event.type) {
		case 'tracking.added': {
			const payload = event.payload as EventPayloadMap['tracking.added'];
			// Two independent LWW fields, so a stale add can't un-remove a title a newer removal deleted.
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
			// Client-resolved and never read server-side; leaving them unprojected keeps the tables derivable.
			return [];
		}
		case 'media.deleted': {
			// A gate, not a filter: `entityId` is client-minted, so an event naming a shared or foreign row must delete nothing.
			return [
				db
					.delete(media)
					.where(
						and(
							eq(media.id, event.entityId),
							eq(media.source, 'custom'),
							eq(media.ownerUserId, event.userId)
						)
					)
			];
		}
	}
}

// Unguarded `min()` is order-independent (the client takes the min too); `added_at` is Unix seconds, clocks epoch ms.
function addedAtFloor(db: Db, userId: string, entityId: string, clockMs: number): Statement {
	return db
		.update(tracking)
		.set({ addedAt: sql`min(${tracking.addedAt}, ${Math.floor(clockMs / 1000)})` })
		.where(eq(tracking.id, trackingKey(userId, entityId)));
}

// Only `tracking.*` events: episode events never create or touch a tracking row, so they're outside `addedAt`.
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

// Log insert and projection share one batch, so a mid-way failure can't persist an event without its projection.
export async function applyEvents(
	db: Db,
	userId: string,
	incoming: EventEnvelope[]
): Promise<ServerEvent[]> {
	if (incoming.length === 0) return [];

	const byId = new Map<string, EventEnvelope>();
	for (const e of incoming) if (!byId.has(e.id)) byId.set(e.id, e);
	const unique = [...byId.values()];

	// Chunked for D1's parameter limit.
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

// Recovery/test oracle; media is reference data, so a rebuild leaves it alone.
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
