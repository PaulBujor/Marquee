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

type TrackingClock = 'statusUpdatedAt' | 'favoriteUpdatedAt' | 'removedUpdatedAt';

/** Read-modify-write a tracking row under LWW guard on `clockField`. */
async function upsertTracking(
	db: MarqueeDatabase,
	mediaId: string,
	clock: number,
	clockField: TrackingClock,
	mutate: (t: ClientTracking) => void
): Promise<void> {
	const tx = db.transaction('tracking', 'readwrite');
	const row: ClientTracking = (await tx.store.get(mediaId)) ?? {
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
		await tx.store.put(row);
	}
	await tx.done;
}

/** Apply a single event to the local materialized stores (idempotent, LWW). */
export async function applyEventToIdb(event: EventEnvelope): Promise<void> {
	const db = await openDb();
	const clock = event.clientCreatedAt;
	const mid = event.entityId;

	switch (event.type) {
		case 'media.tracked': {
			const p = event.payload as EventPayloadMap['media.tracked'];
			const tx = db.transaction('media', 'readwrite');
			const cur = await tx.store.get(mid);
			if (!cur || clock >= cur.updatedAt) {
				await tx.store.put({ id: mid, ...p.media, updatedAt: clock });
			}
			await tx.done;
			await upsertTracking(db, mid, clock, 'statusUpdatedAt', (t) => {
				t.status = p.status;
				t.removed = false;
				t.removedUpdatedAt = clock;
			});
			break;
		}
		case 'tracking.status_changed': {
			const p = event.payload as EventPayloadMap['tracking.status_changed'];
			await upsertTracking(db, mid, clock, 'statusUpdatedAt', (t) => {
				t.status = p.status;
			});
			break;
		}
		case 'tracking.favorite_toggled': {
			const p = event.payload as EventPayloadMap['tracking.favorite_toggled'];
			await upsertTracking(db, mid, clock, 'favoriteUpdatedAt', (t) => {
				t.favorite = p.favorite;
			});
			break;
		}
		case 'tracking.removed': {
			await upsertTracking(db, mid, clock, 'removedUpdatedAt', (t) => {
				t.removed = true;
			});
			break;
		}
		case 'episode.watched':
		case 'episode.unwatched': {
			const p = event.payload as EventPayloadMap['episode.watched'];
			const watched = event.type === 'episode.watched';
			const id = localEpisodeId(mid, p.season, p.episode);
			const tx = db.transaction('episodeWatches', 'readwrite');
			const cur = await tx.store.get(id);
			if (!cur || clock >= cur.updatedAt) {
				const row: ClientEpisodeWatch = {
					id,
					mediaId: mid,
					season: p.season,
					episode: p.episode,
					watched,
					updatedAt: clock
				};
				await tx.store.put(row);
			}
			await tx.done;
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
