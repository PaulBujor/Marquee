/**
 * Client-side IndexedDB: the offline store backing the sync pipeline. It holds an
 * `events` outbox (local events awaiting push) plus materialized `tracking` /
 * `episodeWatches` stores (the client-side projection of the same event log the
 * server materializes) and a `media` reference cache (populated off a separate
 * channel, not derived from events). `upcoming` is provisioned now and populated
 * later by the Timeline epic; `meta` holds the `deviceId` and sync `cursor`. The database
 * itself is namespaced per user (`marquee-<userId>`, see {@link setActiveUser}).
 *
 * Client-safe (browser only) — never imported from server code.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { EventEnvelope, MediaRecord, TrackingStatus } from '$lib/sync/events';

/**
 * An outbox event: the envelope plus a `synced` flag (0 = pending push, 1 = acked).
 * It's `0 | 1`, not a boolean, because the `by_synced` index queries unsynced rows and
 * IndexedDB keys must be number/string/Date/array — a boolean can't be an index key.
 */
export interface OutboxEvent extends EventEnvelope {
	synced: 0 | 1;
}

/** Cached catalog entry (mirrors the server `media` row); `updatedAt` is the LWW clock (epoch ms). */
export interface ClientMedia extends MediaRecord {
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
	addedAt: number;
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

/**
 * Cached artwork for a title — poster + backdrop **image bytes** as Blobs, keyed by our media
 * id, so tracked titles render with zero network and an offline export carries the artwork.
 */
export interface MediaImages {
	id: string;
	poster: Blob | null;
	backdrop: Blob | null;
	updatedAt: number;
}

/** The `meta` key/value store's known keys and the type each maps to. */
export interface MetaValues {
	deviceId: string;
	cursor: number;
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
	mediaImages: { key: string; value: MediaImages };
	episodeWatches: { key: string; value: ClientEpisodeWatch; indexes: { by_media: string } };
	upcoming: { key: string; value: UpcomingEpisode; indexes: { by_media: string } };
	meta: { key: MetaKey; value: MetaEntry };
}

export type MarqueeDatabase = IDBPDatabase<MarqueeDB>;

const DB_NAME = 'marquee';
const DB_VERSION = 2;

let dbPromise: Promise<MarqueeDatabase> | null = null;
let activeUserId: string | null = null;

/**
 * Scope the local store to a signed-in user. The database is **namespaced per user**
 * (`marquee-<userId>`), so switching accounts opens a *different* database — the prior
 * user's data (including unsynced events) is never cleared or exposed to another account.
 * Call once on login (from the root layout) before any store access. Passing `null` (logout)
 * detaches; the next {@link openDb} will throw until a user is set again.
 */
export function setActiveUser(userId: string | null): void {
	if (userId === activeUserId) return;
	activeUserId = userId;
	dbPromise = null; // the next openDb opens the new user's database
}

/** Open (once per active user) that user's database, creating stores/indexes on first use. */
export function openDb(): Promise<MarqueeDatabase> {
	if (!activeUserId) {
		throw new Error('openDb: no active user — call setActiveUser() first');
	}
	if (!dbPromise) {
		dbPromise = openDB<MarqueeDB>(`${DB_NAME}-${activeUserId}`, DB_VERSION, {
			upgrade(db) {
				if (!db.objectStoreNames.contains('events')) {
					const events = db.createObjectStore('events', { keyPath: 'id' });
					events.createIndex('by_synced', 'synced');
					events.createIndex('by_clientCreatedAt', 'clientCreatedAt');
				}
				if (!db.objectStoreNames.contains('tracking')) {
					const tracking = db.createObjectStore('tracking', { keyPath: 'mediaId' });
					tracking.createIndex('by_status', 'status');
				}
				if (!db.objectStoreNames.contains('media'))
					db.createObjectStore('media', { keyPath: 'id' });
				if (!db.objectStoreNames.contains('mediaImages'))
					db.createObjectStore('mediaImages', { keyPath: 'id' });
				if (!db.objectStoreNames.contains('episodeWatches')) {
					const episodeWatches = db.createObjectStore('episodeWatches', { keyPath: 'id' });
					episodeWatches.createIndex('by_media', 'mediaId');
				}
				if (!db.objectStoreNames.contains('upcoming')) {
					const upcoming = db.createObjectStore('upcoming', { keyPath: 'id' });
					upcoming.createIndex('by_media', 'mediaId');
				}
				if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
			}
		});
	}
	return dbPromise;
}
