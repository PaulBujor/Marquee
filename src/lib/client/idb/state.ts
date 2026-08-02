/**
 * Client-side projection: apply an event to the materialized IndexedDB stores.
 * This mirrors the server's `projectEvent` — same deterministic keys, same
 * per-field last-write-wins by `clientCreatedAt` — so local optimistic state and
 * pulled server state converge to the same result regardless of arrival order.
 */
import type { IDBPTransaction } from 'idb';
import { openDb, type ClientEpisodeWatch, type ClientTracking, type MarqueeDB } from './db';
import type { EventEnvelope, EventPayloadMap } from '$lib/sync/events';

/** Client episode key — no userId prefix (the store is already single-user). */
function localEpisodeId(mediaId: string, season: number, episode: number): string {
	return `${mediaId}::s${season}e${episode}`;
}

type TrackingClock =
	'statusUpdatedAt' | 'favoriteUpdatedAt' | 'ratingUpdatedAt' | 'removedUpdatedAt';

/** The stores a projection writes. Both are held by one transaction so a batch commits as a unit. */
const PROJECTION_STORES = ['tracking', 'episodeWatches'] as const;
type ProjectionTx = IDBPTransaction<MarqueeDB, typeof PROJECTION_STORES, 'readwrite'>;

/** Read-modify-write a tracking row under LWW guard on `clockField`, inside a caller's transaction. */
async function upsertTracking(
	tx: ProjectionTx,
	mediaId: string,
	clock: number,
	clockField: TrackingClock,
	mutate: (t: ClientTracking) => void
): Promise<void> {
	const store = tx.objectStore('tracking');
	const existing = await store.get(mediaId);
	const row: ClientTracking = existing ?? {
		mediaId,
		status: 'want_to_watch',
		favorite: false,
		rating: null,
		removed: false,
		statusUpdatedAt: 0,
		favoriteUpdatedAt: 0,
		ratingUpdatedAt: 0,
		removedUpdatedAt: 0,
		addedAt: clock
	};
	// `addedAt` = earliest event clock seen (order-independent), for the "date added" sort.
	row.addedAt = Math.min(existing?.addedAt ?? clock, clock);
	if (clock >= row[clockField]) {
		mutate(row);
		row[clockField] = clock;
	}
	await store.put(row);
}

/** Apply one event within an open projection transaction (idempotent, LWW). */
async function applyEventInTx(tx: ProjectionTx, event: EventEnvelope): Promise<void> {
	const clock = event.clientCreatedAt;
	const entityId = event.entityId;

	switch (event.type) {
		case 'tracking.added': {
			const payload = event.payload as EventPayloadMap['tracking.added'];
			// Media is reference data, handled off the event log; an add only asserts tracking
			// state. Status and revive are independent LWW fields (mirrors the server): a stale
			// add can't un-remove a title a newer removal tombstoned.
			await upsertTracking(tx, entityId, clock, 'statusUpdatedAt', (t) => {
				t.status = payload.status;
			});
			await upsertTracking(tx, entityId, clock, 'removedUpdatedAt', (t) => {
				t.removed = false;
			});
			break;
		}
		case 'tracking.status_changed': {
			const payload = event.payload as EventPayloadMap['tracking.status_changed'];
			await upsertTracking(tx, entityId, clock, 'statusUpdatedAt', (t) => {
				t.status = payload.status;
			});
			break;
		}
		case 'tracking.favorite_toggled': {
			const payload = event.payload as EventPayloadMap['tracking.favorite_toggled'];
			await upsertTracking(tx, entityId, clock, 'favoriteUpdatedAt', (t) => {
				t.favorite = payload.favorite;
			});
			break;
		}
		case 'tracking.rated': {
			const payload = event.payload as EventPayloadMap['tracking.rated'];
			await upsertTracking(tx, entityId, clock, 'ratingUpdatedAt', (t) => {
				t.rating = payload.rating;
			});
			break;
		}
		case 'tracking.removed': {
			await upsertTracking(tx, entityId, clock, 'removedUpdatedAt', (t) => {
				t.removed = true;
			});
			break;
		}
		case 'episode.watched':
		case 'episode.unwatched': {
			const payload = event.payload as EventPayloadMap['episode.watched'];
			const watched = event.type === 'episode.watched';
			const id = localEpisodeId(entityId, payload.season, payload.episode);
			const store = tx.objectStore('episodeWatches');
			const current = await store.get(id);
			if (!current || clock >= current.updatedAt) {
				const row: ClientEpisodeWatch = {
					id,
					mediaId: entityId,
					season: payload.season,
					episode: payload.episode,
					watched,
					updatedAt: clock
				};
				await store.put(row);
			}
			break;
		}
	}
}

/** Apply a single event to the local materialized stores (idempotent, LWW). */
export async function applyEventToIdb(event: EventEnvelope): Promise<void> {
	const db = await openDb();
	const tx = db.transaction(PROJECTION_STORES, 'readwrite');
	await applyEventInTx(tx, event);
	await tx.done;
}

/**
 * Apply many events in **one** transaction — same rules as {@link applyEventToIdb}, and the
 * per-field LWW guards keep the result independent of the order passed in. For imports: one at a
 * time, a few hundred titles runs into thousands of round trips with the UI blocked behind them.
 */
export async function applyEventsToIdb(events: EventEnvelope[]): Promise<void> {
	if (events.length === 0) return;
	const db = await openDb();
	const tx = db.transaction(PROJECTION_STORES, 'readwrite');
	for (const event of events) await applyEventInTx(tx, event);
	await tx.done;
}

/** All non-removed tracking rows (optionally filtered by status). */
export async function getTracking(status?: ClientTracking['status']): Promise<ClientTracking[]> {
	const db = await openDb();
	const rows = status
		? await db.getAllFromIndex('tracking', 'by_status', status)
		: await db.getAll('tracking');
	return rows.filter((r) => !r.removed);
}

/** The tracking row for a single title, or undefined if never tracked. Includes tombstoned (removed) rows — the caller decides how to read them (see `toTrackingView`). */
export async function getTrackingByMediaId(mediaId: string): Promise<ClientTracking | undefined> {
	const db = await openDb();
	return db.get('tracking', mediaId);
}

/** Watched-episode rows for a show. */
export async function getEpisodeWatches(mediaId: string): Promise<ClientEpisodeWatch[]> {
	const db = await openDb();
	return db.getAllFromIndex('episodeWatches', 'by_media', mediaId);
}

/**
 * Every episode-watch row across all shows, in one read. Includes `watched: false` rows (the LWW
 * tombstones a later unwatch leaves behind) — callers filter as they need. Used by the export,
 * which would otherwise need a per-title index scan.
 */
export async function getAllEpisodeWatches(): Promise<ClientEpisodeWatch[]> {
	const db = await openDb();
	return db.getAll('episodeWatches');
}
