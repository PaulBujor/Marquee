/**
 * Client-side projection: apply an event to the materialized IndexedDB stores.
 * This mirrors the server's `projectEvent` — same deterministic keys, same
 * per-field last-write-wins by `clientCreatedAt` — so local optimistic state and
 * pulled server state converge to the same result regardless of arrival order.
 */
import { openDb, type ClientEpisodeWatch, type ClientTracking, type MarqueeDatabase } from './db';
import {
	mediaId,
	type EventEnvelope,
	type EventPayloadMap,
	type MediaSnapshot
} from '$lib/sync/events';

/**
 * Cache a media snapshot in the local reference store (media is reference data, kept
 * separate from the event log). LWW by `cachedAt` (epoch ms). Call this when adding a
 * title so it renders offline; the sync engine (MRQ-43) pushes cached media as the
 * request's `media` sidecar.
 */
export async function cacheMedia(
	snapshot: MediaSnapshot,
	cachedAt: number = Date.now()
): Promise<void> {
	const db = await openDb();
	const id = mediaId(snapshot.type, snapshot.tmdbId);
	const transaction = db.transaction('media', 'readwrite');
	const current = await transaction.store.get(id);
	if (!current || cachedAt >= current.updatedAt) {
		await transaction.store.put({ id, ...snapshot, updatedAt: cachedAt });
	}
	await transaction.done;
}

/** Client episode key — no userId prefix (the store is already single-user). */
function localEpisodeId(mediaId: string, season: number, episode: number): string {
	return `${mediaId}::s${season}e${episode}`;
}

type TrackingClock = 'statusUpdatedAt' | 'favoriteUpdatedAt' | 'removedUpdatedAt';

/** Read-modify-write a tracking row under LWW guard on `clockField`. */
async function upsertTracking(
	db: MarqueeDatabase,
	mediaId: string,
	clock: number,
	clockField: TrackingClock,
	mutate: (t: ClientTracking) => void
): Promise<void> {
	const transaction = db.transaction('tracking', 'readwrite');
	const row: ClientTracking = (await transaction.store.get(mediaId)) ?? {
		mediaId,
		status: 'want_to_watch',
		favorite: false,
		removed: false,
		statusUpdatedAt: 0,
		favoriteUpdatedAt: 0,
		removedUpdatedAt: 0
	};
	if (clock >= row[clockField]) {
		mutate(row);
		row[clockField] = clock;
		await transaction.store.put(row);
	}
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
			// Media is cached separately (see cacheMedia); an add only asserts tracking state.
			// Status and revive are independent LWW fields (mirrors the server): a stale add
			// can't un-remove a title a newer removal tombstoned.
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

/** Watched-episode rows for a show. */
export async function getEpisodeWatches(mediaId: string): Promise<ClientEpisodeWatch[]> {
	const db = await openDb();
	return db.getAllFromIndex('episodeWatches', 'by_media', mediaId);
}
