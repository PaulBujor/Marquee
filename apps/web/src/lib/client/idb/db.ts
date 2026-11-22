import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { reportClientError } from '#lib/client/report-error.js';
import type {
	EventEnvelope,
	HydratableProvider,
	MediaCredit,
	MediaEpisode,
	MediaRecord,
	MediaSeason,
	TrackingStatus
} from '#lib/sync/events.js';

/** `0 | 1`, not a boolean: `by_synced` indexes it, and IndexedDB keys can't be booleans. */
export interface OutboxEvent extends EventEnvelope {
	synced: 0 | 1;
}

export type MediaScalars = Omit<MediaRecord, 'seasons' | 'episodes' | 'credits'>;

/** `updatedAt` is the LWW clock (epoch ms). */
export interface ClientMedia extends MediaScalars {
	updatedAt: number;
	/** Custom media only; cleared once the media channel reports the record stored. */
	pendingPush?: 0 | 1;
	/**
	 * The LWW clock the server compares two devices' edits by — unlike `updatedAt` it must move only
	 * when the *user* changes something, not on a channel pull.
	 */
	editedAt?: number;
}

/** `id` = `${mediaId}::s{seasonNumber}`. */
export interface ClientSeason extends MediaSeason {
	id: string;
	mediaId: string;
}

/** `id` = `${mediaId}::s{S}e{E}`. A null `airDate` is absent from the `by_airDate` index. */
export interface ClientEpisode extends MediaEpisode {
	id: string;
	mediaId: string;
}

/**
 * `id` = `${mediaId}::{role}::{personId}` — the server's uniqueness flattened into a key; `by_person`
 * serves the reverse lookup offline.
 */
export interface ClientCredit extends MediaCredit {
	id: string;
	mediaId: string;
}

/** Single-user client, so keyed by `mediaId`. Per-field LWW clocks. */
export interface ClientTracking {
	mediaId: string;
	status: TrackingStatus;
	favorite: boolean;
	/** 1–5; null = unrated. */
	rating: number | null;
	removed: boolean;
	statusUpdatedAt: number;
	favoriteUpdatedAt: number;
	ratingUpdatedAt: number;
	removedUpdatedAt: number;
	addedAt: number;
}

/**
 * Client-only: the server stores the `media.*` events but materializes nothing from them (see
 * `server/sync/projection.ts`). Per-field LWW clocks, so a link and a dismissal merge independently.
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

/** `id` = `${mediaId}::s{S}e{E}`. */
export interface ClientEpisodeWatch {
	id: string;
	mediaId: string;
	season: number;
	episode: number;
	watched: boolean;
	updatedAt: number;
}

export interface MediaImages {
	id: string;
	poster: Blob | null;
	backdrop: Blob | null;
	updatedAt: number;
}

export interface MetaValues {
	deviceId: string;
	cursor: number;
	/** Epoch ms. */
	lastSyncAt: number;
	/** Epoch ms; lets the cadence survive a PWA relaunch. */
	lastFullMediaCheck: number;
	recentSearches: string[];
}
export type MetaKey = keyof MetaValues;
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
	credits: {
		key: string;
		value: ClientCredit;
		indexes: { by_media: string; by_person: string };
	};
	mediaImages: { key: string; value: MediaImages };
	mediaLinks: { key: string; value: ClientMediaLink };
	episodeWatches: { key: string; value: ClientEpisodeWatch; indexes: { by_media: string } };
	meta: { key: MetaKey; value: MetaEntry };
}

export type MarqueeDatabase = IDBPDatabase<MarqueeDB>;

const DB_NAME = 'marquee';
const DB_VERSION = 5;

let dbPromise: Promise<MarqueeDatabase> | null = null;
let activeUserId: string | null = null;

/**
 * Per-user database (`marquee-<userId>`), so switching accounts opens a *different* database — the
 * prior user's data is never cleared or exposed to another account.
 */
export function setActiveUser(userId: string | null): void {
	if (userId === activeUserId) return;
	activeUserId = userId;
	dbPromise = null; // the next openDb opens the new user's database
}

/** Caller must flush pending events first — unsynced edits are lost. No-op when no user is active. */
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

export function openDb(): Promise<MarqueeDatabase> {
	if (!activeUserId) {
		return Promise.reject(new Error('openDb: no active user — call setActiveUser() first'));
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
				if (!db.objectStoreNames.contains('credits')) {
					const credits = db.createObjectStore('credits', { keyPath: 'id' });
					credits.createIndex('by_media', 'mediaId');
					credits.createIndex('by_person', 'personId');
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
			/** This tab holds an old version: close so the other can upgrade — it's superseded anyway. */
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
