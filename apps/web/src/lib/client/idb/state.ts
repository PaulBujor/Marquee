/**
 * Mirrors the server's `projectEvent` — same deterministic keys, same per-field LWW by
 * `clientCreatedAt` — so local optimistic and pulled state converge regardless of arrival order.
 */
import type { IDBPTransaction } from 'idb';
import {
	openDb,
	type ClientEpisodeWatch,
	type ClientMediaLink,
	type ClientTracking,
	type MarqueeDB
} from './db';
import { deleteLocalMedia } from './media';
import type { EventEnvelope, EventPayloadMap } from '#lib/sync/events.js';

/** Client episode key — no userId prefix (the store is already single-user). */
function localEpisodeId(mediaId: string, season: number, episode: number): string {
	return `${mediaId}::s${season}e${episode}`;
}

type TrackingClock =
	'statusUpdatedAt' | 'favoriteUpdatedAt' | 'ratingUpdatedAt' | 'removedUpdatedAt';

/** The stores a projection writes. All are held by one transaction so a batch commits as a unit. */
const PROJECTION_STORES = ['tracking', 'episodeWatches', 'mediaLinks'] as const;
type ProjectionTx = IDBPTransaction<MarqueeDB, typeof PROJECTION_STORES, 'readwrite'>;

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

type MediaLinkClock = 'linkedUpdatedAt' | 'declinedUpdatedAt';

async function upsertMediaLink(
	tx: ProjectionTx,
	mediaId: string,
	clock: number,
	clockField: MediaLinkClock,
	mutate: (l: ClientMediaLink) => void
): Promise<void> {
	const store = tx.objectStore('mediaLinks');
	const existing = await store.get(mediaId);
	const row: ClientMediaLink = existing ?? {
		mediaId,
		targetId: null,
		provider: null,
		externalId: null,
		declined: false,
		linkedUpdatedAt: 0,
		declinedUpdatedAt: 0
	};
	if (clock >= row[clockField]) {
		mutate(row);
		row[clockField] = clock;
	}
	await store.put(row);
}

async function applyEventInTx(tx: ProjectionTx, event: EventEnvelope): Promise<void> {
	const clock = event.clientCreatedAt;
	const entityId = event.entityId;

	switch (event.type) {
		case 'tracking.added': {
			const payload = event.payload as EventPayloadMap['tracking.added'];
			// Status and revive are independent LWW fields — a stale add can't un-remove a newer
			// removal.
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
		case 'media.linked': {
			const payload = event.payload as EventPayloadMap['media.linked'];
			// Match and dismissal are independent LWW fields — accepting clears an earlier decline.
			await upsertMediaLink(tx, entityId, clock, 'linkedUpdatedAt', (l) => {
				l.targetId = payload.targetId;
				l.provider = payload.provider;
				l.externalId = payload.externalId;
			});
			await upsertMediaLink(tx, entityId, clock, 'declinedUpdatedAt', (l) => {
				l.declined = false;
			});
			break;
		}
		case 'media.unlinked': {
			/** Only the link field moves — unlinked doesn't affect the declined/suggestion clock. */
			await upsertMediaLink(tx, entityId, clock, 'linkedUpdatedAt', (l) => {
				l.targetId = null;
				l.provider = null;
				l.externalId = null;
			});
			break;
		}
		case 'media.match_declined': {
			await upsertMediaLink(tx, entityId, clock, 'declinedUpdatedAt', (l) => {
				l.declined = true;
			});
			break;
		}
		case 'media.deleted':
			// Handled after this transaction commits — see `deletedMediaIds`.
			break;
	}
}

/** Kept out of the projection transaction: widening it would make every tracking write lock the cache. */
function deletedMediaIds(events: EventEnvelope[]): string[] {
	return events.filter((e) => e.type === 'media.deleted').map((e) => e.entityId);
}

export async function applyEventToIdb(event: EventEnvelope): Promise<void> {
	const db = await openDb();
	const tx = db.transaction(PROJECTION_STORES, 'readwrite');
	await applyEventInTx(tx, event);
	await tx.done;
	await deleteLocalMedia(deletedMediaIds([event]));
}

/** One transaction — a few hundred titles one at a time is thousands of round trips. */
export async function applyEventsToIdb(events: EventEnvelope[]): Promise<void> {
	if (events.length === 0) return;
	const db = await openDb();
	const tx = db.transaction(PROJECTION_STORES, 'readwrite');
	for (const event of events) await applyEventInTx(tx, event);
	await tx.done;
	await deleteLocalMedia(deletedMediaIds(events));
}

export async function getTracking(status?: ClientTracking['status']): Promise<ClientTracking[]> {
	const db = await openDb();
	const rows = status
		? await db.getAllFromIndex('tracking', 'by_status', status)
		: await db.getAll('tracking');
	return rows.filter((r) => !r.removed);
}

/** Includes tombstoned (removed) rows — the caller decides how to read them. */
export async function getTrackingByMediaId(mediaId: string): Promise<ClientTracking | undefined> {
	const db = await openDb();
	return db.get('tracking', mediaId);
}

export async function getMediaLink(mediaId: string): Promise<ClientMediaLink | undefined> {
	const db = await openDb();
	return db.get('mediaLinks', mediaId);
}

/** Entries matched *to* `targetId` — reverse lookup of getMediaLink. Small store; scan is fine. */
export async function getMediaLinksTo(targetId: string): Promise<ClientMediaLink[]> {
	const db = await openDb();
	return (await db.getAll('mediaLinks')).filter((l) => l.targetId === targetId);
}

export async function getEpisodeWatches(mediaId: string): Promise<ClientEpisodeWatch[]> {
	const db = await openDb();
	return db.getAllFromIndex('episodeWatches', 'by_media', mediaId);
}

/** Includes `watched: false` LWW tombstones — callers filter as they need. */
export async function getAllEpisodeWatches(): Promise<ClientEpisodeWatch[]> {
	const db = await openDb();
	return db.getAll('episodeWatches');
}
