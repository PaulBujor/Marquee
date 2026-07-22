/**
 * Client-side IndexedDB: the offline store backing the sync pipeline. It holds an
 * `events` outbox (local events awaiting push) plus materialized `tracking` /
 * `episodeWatches` stores (the client-side projection of the same event log the
 * server materializes) and a `media` reference cache (populated off a separate
 * channel, not derived from events). `upcoming` is provisioned now and populated
 * later by the Timeline epic; `meta` holds the `deviceId`, sync `cursor`, and `userId`.
 *
 * Client-safe (browser only) — never imported from server code.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { EventEnvelope, MediaSnapshot, TrackingStatus } from '$lib/sync/events';

/**
 * An outbox event: the envelope plus a `synced` flag (0 = pending push, 1 = acked).
 * It's `0 | 1`, not a boolean, because the `by_synced` index queries unsynced rows and
 * IndexedDB keys must be number/string/Date/array — a boolean can't be an index key.
 */
export interface OutboxEvent extends EventEnvelope {
	synced: 0 | 1;
}

/** Cached catalog entry (mirrors the server `media` row); `updatedAt` is the LWW clock (epoch ms). */
export interface ClientMedia extends MediaSnapshot {
	id: string;
	updatedAt: number;
}

/** Materialized tracking row (single-user client, so keyed by `mediaId`). Per-field LWW clocks. */
export interface ClientTracking {
	mediaId: string;
	status: TrackingStatus;
	favorite: boolean;
	/** Optional user rating 1–5; null = unrated. */
	rating: number | null;
	removed: boolean;
	statusUpdatedAt: number;
	favoriteUpdatedAt: number;
	ratingUpdatedAt: number;
	removedUpdatedAt: number;
}

/** Materialized per-episode watched state. `id` = `${mediaId}::s{S}e{E}`. */
export interface ClientEpisodeWatch {
	id: string;
	mediaId: string;
	season: number;
	episode: number;
	watched: boolean;
	updatedAt: number;
}

/** Cached upcoming release (populated by the later Timeline epic). */
export interface UpcomingEpisode {
	id: string;
	mediaId: string;
	season: number;
	episode: number;
	title: string;
	airDate: string;
	cachedAt: number;
}

/** The `meta` key/value store's known keys and the type each maps to. */
export interface MetaValues {
	deviceId: string;
	cursor: number;
	userId: string;
}
export type MetaKey = keyof MetaValues;
/** A single `meta` row — a known key paired with its typed value. */
export type MetaEntry = { [K in MetaKey]: { key: K; value: MetaValues[K] } }[MetaKey];

interface MarqueeDB extends DBSchema {
	events: {
		key: string;
		value: OutboxEvent;
		indexes: { by_synced: number; by_clientCreatedAt: number };
	};
	tracking: { key: string; value: ClientTracking; indexes: { by_status: string } };
	media: { key: string; value: ClientMedia };
	episodeWatches: { key: string; value: ClientEpisodeWatch; indexes: { by_media: string } };
	upcoming: { key: string; value: UpcomingEpisode; indexes: { by_media: string } };
	meta: { key: MetaKey; value: MetaEntry };
}

export type MarqueeDatabase = IDBPDatabase<MarqueeDB>;

const DB_NAME = 'marquee';
const DB_VERSION = 1;

let dbPromise: Promise<MarqueeDatabase> | null = null;

/** Open (once) the singleton database, creating stores/indexes on first use. */
export function openDb(): Promise<MarqueeDatabase> {
	if (!dbPromise) {
		dbPromise = openDB<MarqueeDB>(DB_NAME, DB_VERSION, {
			upgrade(db) {
				const events = db.createObjectStore('events', { keyPath: 'id' });
				events.createIndex('by_synced', 'synced');
				events.createIndex('by_clientCreatedAt', 'clientCreatedAt');

				const tracking = db.createObjectStore('tracking', { keyPath: 'mediaId' });
				tracking.createIndex('by_status', 'status');

				db.createObjectStore('media', { keyPath: 'id' });

				const episodeWatches = db.createObjectStore('episodeWatches', { keyPath: 'id' });
				episodeWatches.createIndex('by_media', 'mediaId');

				const upcoming = db.createObjectStore('upcoming', { keyPath: 'id' });
				upcoming.createIndex('by_media', 'mediaId');

				db.createObjectStore('meta', { keyPath: 'key' });
			}
		});
	}
	return dbPromise;
}
