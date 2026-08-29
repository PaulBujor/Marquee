/**
 * Client-side IndexedDB: offline store for the sync pipeline. Holds an `events` outbox,
 * materialized `tracking` / `episodeWatches` stores (client projection of the event log),
 * a `media` reference cache with `seasons`/`episodes` children, and `mediaLinks` for
 * `media.*` identity decisions. `meta` holds `deviceId` and sync `cursor`. Database is
 * namespaced per user (`marquee-<userId>`). Client-safe only.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { reportClientError } from '$lib/client/report-error';
import type {
	EventEnvelope,
	HydratableProvider,
	MediaEpisode,
	MediaRecord,
	MediaSeason,
	TrackingStatus
} from '$lib/sync/events';

/**
 * Outbox event: the envelope plus a `synced` flag. `0 | 1` (not boolean) because IndexedDB
 * index keys must be number/string/Date/array.
 */
export interface OutboxEvent extends EventEnvelope {
	synced: 0 | 1;
}

/** A media record's scalar fields; its seasons/episodes live in their own stores. */
export type MediaScalars = Omit<MediaRecord, 'seasons' | 'episodes'>;

/** `updatedAt` is the LWW clock (epoch ms). */
export interface ClientMedia extends MediaScalars {
	updatedAt: number;
	/** Custom only: 1 while the author's edit still needs backing up to the server. */
	pendingPush?: 0 | 1;
	/** Custom only: epoch ms of the author's last local edit (the LWW clock for two-device edits). */
	editedAt?: number;
}

/** `id` = `${mediaId}::s{seasonNumber}`. */
export interface ClientSeason extends MediaSeason {
	id: string;
	mediaId: string;
}

/** `id` = `${mediaId}::s{S}e{E}`. A null `airDate` excludes it from the `by_airDate` index. */
export interface ClientEpisode extends MediaEpisode {
	id: string;
	mediaId: string;
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

/**
 * Materialized identity decision for one media reference: the provider-backed title the user
 * matched it to, and whether they've dismissed the suggestion. Keyed by source id (a custom entry).
 */
export interface ClientMediaLink {
	mediaId: string;
	/** Our media id for the matched title, or null when only a dismissal has been recorded. */
	targetId: string | null;
	provider: HydratableProvider | null;
	externalId: string | null;
	declined: boolean;
	linkedUpdatedAt: number;
	declinedUpdatedAt: number;
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

/** Cached poster + backdrop image bytes, keyed by media id. */
export interface MediaImages {
	id: string;
	poster: Blob | null;
	backdrop: Blob | null;
	updatedAt: number;
}

/** The `meta` key/value store's known keys. */
export interface MetaValues {
	deviceId: string;
	cursor: number;
	/** Epoch ms of the last successful event sync — shown in settings, drives "last synced". */
	lastSyncAt: number;
	/** Epoch ms of the last full media version-diff pass — lets the cadence survive a PWA relaunch. */
	lastFullMediaCheck: number;
	/** Last 5 committed search queries, most recent first — local-only, never synced. */
	recentSearches: string[];
}
export type MetaKey = keyof MetaValues;
/** A single `meta` row — a known key paired with its typed value. */
export type MetaEntry = { [K in MetaKey]: { key: K; value: MetaValues[K] } }[MetaKey];

export interface MarqueeDB extends DBSchema {
	events: {
		key: string;
		value: OutboxEvent;
		indexes: { by_synced: number; by_clientCreatedAt: number };
	};
	tracking: { key: string; value: ClientTracking; indexes: { by_status: string } };
	media: { key: string; value: ClientMedia };
	seasons: { key: string; value: ClientSeason; indexes: { by_media: string } };
	episodes: {
		key: string;
		value: ClientEpisode;
		indexes: { by_media: string; by_airDate: string };
	};
	mediaImages: { key: string; value: MediaImages };
	mediaLinks: { key: string; value: ClientMediaLink };
	episodeWatches: { key: string; value: ClientEpisodeWatch; indexes: { by_media: string } };
	meta: { key: MetaKey; value: MetaEntry };
}

export type MarqueeDatabase = IDBPDatabase<MarqueeDB>;

const DB_NAME = 'marquee';
const DB_VERSION = 4;

let dbPromise: Promise<MarqueeDatabase> | null = null;
let activeUserId: string | null = null;

/**
 * Scope the local store to a signed-in user (`marquee-<userId>`). Call once on login before any
 * store access. Passing `null` (logout) detaches; the next {@link openDb} will throw until a user
 * is set again.
 */
export function setActiveUser(userId: string | null): void {
	if (userId === activeUserId) return;
	activeUserId = userId;
	dbPromise = null; // the next openDb opens the new user's database
}

/**
 * Delete the active user's local database (offline replica + outbox + cursor). The next
 * {@link openDb} recreates it empty. Caller should flush pending events first and reload after.
 */
export async function wipeLocalData(): Promise<void> {
	if (!activeUserId || typeof indexedDB === 'undefined') return;
	const name = `${DB_NAME}-${activeUserId}`;
	if (dbPromise) {
		const db = await dbPromise.catch(() => null);
		db?.close();
		dbPromise = null;
	}
	await new Promise<void>((resolve, reject) => {
		const req = indexedDB.deleteDatabase(name);
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
		// Another tab holds the DB open — the delete completes once it closes; don't hang the reset.
		req.onblocked = () => resolve();
	});
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
				if (!db.objectStoreNames.contains('seasons')) {
					const seasons = db.createObjectStore('seasons', { keyPath: 'id' });
					seasons.createIndex('by_media', 'mediaId');
				}
				if (!db.objectStoreNames.contains('episodes')) {
					const episodes = db.createObjectStore('episodes', { keyPath: 'id' });
					episodes.createIndex('by_media', 'mediaId');
					episodes.createIndex('by_airDate', 'airDate');
				}
				if (!db.objectStoreNames.contains('mediaImages'))
					db.createObjectStore('mediaImages', { keyPath: 'id' });
				if (!db.objectStoreNames.contains('mediaLinks'))
					db.createObjectStore('mediaLinks', { keyPath: 'mediaId' });
				if (!db.objectStoreNames.contains('episodeWatches')) {
					const episodeWatches = db.createObjectStore('episodeWatches', { keyPath: 'id' });
					episodeWatches.createIndex('by_media', 'mediaId');
				}
				// Drop the superseded `upcoming` store (v2); cast because it's no longer typed.
				const legacy = db as unknown as IDBPDatabase;
				if (legacy.objectStoreNames.contains('upcoming')) legacy.deleteObjectStore('upcoming');
				if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
			},
			/**
			 * Another tab still has the database open at an older version, so our upgrade can't run.
			 * Without this the open **hangs forever** — no error, no rejection — and every read and
			 * write behind it hangs with it, which surfaces as the app silently doing nothing.
			 */
			blocked(currentVersion, blockedVersion) {
				reportClientError({
					message: `idb: upgrade to v${blockedVersion} blocked by a tab holding v${currentVersion}`,
					source: 'idb-blocked',
					at: Date.now()
				});
			},
			/**
			 * The mirror case: *this* tab is holding an old version open while another wants to
			 * upgrade. Close so it can proceed — this tab is running superseded code anyway, and the
			 * next `openDb()` reopens at the new version.
			 */
			blocking() {
				void dbPromise?.then((db) => db.close()).catch(() => {});
				dbPromise = null;
			},
			/** The browser evicted the connection (storage pressure, or the tab was backgrounded out). */
			terminated() {
				dbPromise = null;
			}
		});
		// A failed open must not be cached as a permanently-rejected promise: every later call would
		// reuse the rejection and the store would stay dead for the life of the page.
		dbPromise.catch(() => {
			dbPromise = null;
		});
	}
	return dbPromise;
}
