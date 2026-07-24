/**
 * Client-side projection: apply an event to the materialized IndexedDB stores.
 * This mirrors the server's `projectEvent` — same deterministic keys, same
 * per-field last-write-wins by `clientCreatedAt` — so local optimistic state and
 * pulled server state converge to the same result regardless of arrival order.
 */
import { openDb, type ClientEpisodeWatch, type ClientTracking, type MarqueeDatabase } from './db';
import type { EventEnvelope, EventPayloadMap } from '$lib/sync/events';

/** Client episode key — no userId prefix (the store is already single-user). */
function localEpisodeId(mediaId: string, season: number, episode: number): string {
	return `${mediaId}::s${season}e${episode}`;
}

type TrackingClock =
	'statusUpdatedAt' | 'favoriteUpdatedAt' | 'ratingUpdatedAt' | 'removedUpdatedAt';

/** Read-modify-write a tracking row under LWW guard on `clockField`. */
async function upsertTracking(
	db: MarqueeDatabase,
	mediaId: string,
	clock: number,
	clockField: TrackingClock,
	mutate: (t: ClientTracking) => void
): Promise<void> {
	const transaction = db.transaction('tracking', 'readwrite');
	const existing = await transaction.store.get(mediaId);
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
	await transaction.store.put(row);
	await transaction.done;
}

/** Apply a single event to the local materialized stores (idempotent, LWW). */
export async function applyEventToIdb(event: EventEnvelope): Promise<void> {
	const db = await openDb();
	const clock = event.clientCreatedAt;
	const entityId = event.entityId;

	switch (event.type) {
		case 'tracking.added': {
			const payload = event.payload as EventPayloadMap['tracking.added'];
			// Media is reference data, handled off the event log; an add only asserts tracking
			// state. Status and revive are independent LWW fields (mirrors the server): a stale
			// add can't un-remove a title a newer removal tombstoned.
			await upsertTracking(db, entityId, clock, 'statusUpdatedAt', (t) => {
				t.status = payload.status;
			});
			await upsertTracking(db, entityId, clock, 'removedUpdatedAt', (t) => {
				t.removed = false;
			});
			break;
		}
		case 'tracking.status_changed': {
			const payload = event.payload as EventPayloadMap['tracking.status_changed'];
			await upsertTracking(db, entityId, clock, 'statusUpdatedAt', (t) => {
				t.status = payload.status;
			});
			break;
		}
		case 'tracking.favorite_toggled': {
			const payload = event.payload as EventPayloadMap['tracking.favorite_toggled'];
			await upsertTracking(db, entityId, clock, 'favoriteUpdatedAt', (t) => {
				t.favorite = payload.favorite;
			});
			break;
		}
		case 'tracking.rated': {
			const payload = event.payload as EventPayloadMap['tracking.rated'];
			await upsertTracking(db, entityId, clock, 'ratingUpdatedAt', (t) => {
				t.rating = payload.rating;
			});
			break;
		}
		case 'tracking.removed': {
			await upsertTracking(db, entityId, clock, 'removedUpdatedAt', (t) => {
				t.removed = true;
			});
			break;
		}
		case 'episode.watched':
		case 'episode.unwatched': {
			const payload = event.payload as EventPayloadMap['episode.watched'];
			const watched = event.type === 'episode.watched';
			const id = localEpisodeId(entityId, payload.season, payload.episode);
			const transaction = db.transaction('episodeWatches', 'readwrite');
			const current = await transaction.store.get(id);
			if (!current || clock >= current.updatedAt) {
				const row: ClientEpisodeWatch = {
					id,
					mediaId: entityId,
					season: payload.season,
					episode: payload.episode,
					watched,
					updatedAt: clock
				};
				await transaction.store.put(row);
			}
			await transaction.done;
			break;
		}
	}
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
