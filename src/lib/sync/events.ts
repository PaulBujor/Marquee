/**
 * Canonical event model for the event-sourced sync pipeline.
 *
 * The event log is the single source of truth: both the server's D1 materialized
 * tables and the client's IndexedDB materialized stores are *projections* of the
 * same events defined here. This module is **client-safe** — no server-only
 * imports — so it can be imported from both `src/lib/server` and browser code.
 */

/** Bumped when the envelope/payload shapes change, so future events can be migrated. */
export const EVENT_SCHEMA_VERSION = 1;

/** Tracking status for a title on a user's watchlist. */
export const TRACKING_STATUSES = ['want_to_watch', 'watching', 'completed'] as const;
export type TrackingStatus = (typeof TRACKING_STATUSES)[number];

/** The kinds of events the foundation supports (enough to prove the pipeline). */
export const SYNC_EVENT_TYPES = [
	'media.tracked',
	'tracking.status_changed',
	'tracking.favorite_toggled',
	'episode.watched',
	'episode.unwatched',
	'tracking.removed'
] as const;
export type SyncEventType = (typeof SYNC_EVENT_TYPES)[number];

/**
 * A minimal media descriptor carried by `media.tracked` so the server can populate
 * its catalog cache without a TMDB round-trip. Mirrors `MediaSearchResult`
 * (`src/lib/server/tmdb/types.ts`) — TMDB stays the real source, this is display cache.
 */
export interface MediaSnapshot {
	tmdbId: number;
	type: 'movie' | 'show';
	title: string;
	year: number | null;
	posterPath: string | null;
	overview: string;
}

/** Payload shape per event type — the discriminated union that drives projection. */
export interface EventPayloadMap {
	'media.tracked': { media: MediaSnapshot; status: TrackingStatus };
	'tracking.status_changed': { status: TrackingStatus };
	'tracking.favorite_toggled': { favorite: boolean };
	'episode.watched': { season: number; episode: number };
	'episode.unwatched': { season: number; episode: number };
	'tracking.removed': Record<string, never>;
}

/**
 * An event as produced and stored by a client. `id` is a client-generated UUID that
 * doubles as the global dedup key; `entityId` is the deterministic `mediaId` the event
 * targets. The client never sets `userId`/`seq` — the server assigns those on persist.
 */
export interface EventEnvelope<T extends SyncEventType = SyncEventType> {
	id: string;
	type: T;
	entityId: string;
	payload: EventPayloadMap[T];
	deviceId: string;
	/** Epoch ms on the originating device — the LWW ordering clock (untrusted, but authoritative for merge). */
	clientCreatedAt: number;
	schemaVersion: number;
}

/** The persisted shape the server returns on pull: an envelope augmented with server-assigned fields. */
export interface ServerEvent<T extends SyncEventType = SyncEventType> extends EventEnvelope<T> {
	userId: string;
	/** Per-user monotonic sequence assigned by the server; the sync cursor is the highest seq pulled. */
	seq: number;
	/** Epoch ms the server received the event. */
	serverReceivedAt: number;
}

/** Deterministic id for a title in the catalog, e.g. `movie:603`. */
export function mediaId(type: 'movie' | 'show', tmdbId: number): string {
	return `${type}:${tmdbId}`;
}

/** Deterministic PK for a user's tracking row of a title. */
export function trackingKey(userId: string, media: string): string {
	return `${userId}::${media}`;
}

/** Deterministic PK for a user's watched-state of a single episode. */
export function episodeKey(userId: string, media: string, season: number, episode: number): string {
	return `${userId}::${media}::s${season}e${episode}`;
}

/**
 * Build a new event, stamping the client-owned fields. `entityId` is the target
 * `mediaId`; use {@link mediaId} to derive it.
 */
export function createEvent<T extends SyncEventType>(
	type: T,
	entityId: string,
	payload: EventPayloadMap[T],
	deviceId: string
): EventEnvelope<T> {
	return {
		id: crypto.randomUUID(),
		type,
		entityId,
		payload,
		deviceId,
		clientCreatedAt: Date.now(),
		schemaVersion: EVENT_SCHEMA_VERSION
	};
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPositiveInt(v: unknown): v is number {
	return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function isValidPayload(type: SyncEventType, payload: unknown): boolean {
	if (typeof payload !== 'object' || payload === null) return false;
	const p = payload as Record<string, unknown>;
	switch (type) {
		case 'media.tracked': {
			const m = p.media as Record<string, unknown> | undefined;
			return (
				(TRACKING_STATUSES as readonly string[]).includes(p.status as string) &&
				!!m &&
				isPositiveInt(m.tmdbId) &&
				(m.type === 'movie' || m.type === 'show') &&
				typeof m.title === 'string'
			);
		}
		case 'tracking.status_changed':
			return (TRACKING_STATUSES as readonly string[]).includes(p.status as string);
		case 'tracking.favorite_toggled':
			return typeof p.favorite === 'boolean';
		case 'episode.watched':
		case 'episode.unwatched':
			return isPositiveInt(p.season) && isPositiveInt(p.episode);
		case 'tracking.removed':
			return true;
	}
}

/**
 * Validate an untrusted event (from the network or IndexedDB). Returns the typed
 * envelope when well-formed, else `null`. Re-run **server-side authoritatively** —
 * the client's own validation is only for early feedback (per the app's validate-on-
 * both-sides convention).
 */
export function validateEvent(raw: unknown): EventEnvelope | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const e = raw as Record<string, unknown>;
	if (typeof e.id !== 'string' || !UUID_RE.test(e.id)) return null;
	if (typeof e.deviceId !== 'string' || !UUID_RE.test(e.deviceId)) return null;
	if (typeof e.type !== 'string' || !(SYNC_EVENT_TYPES as readonly string[]).includes(e.type)) {
		return null;
	}
	if (typeof e.entityId !== 'string' || e.entityId.length === 0) return null;
	if (typeof e.clientCreatedAt !== 'number' || !Number.isFinite(e.clientCreatedAt)) return null;
	if (typeof e.schemaVersion !== 'number') return null;
	if (!isValidPayload(e.type as SyncEventType, e.payload)) return null;
	return e as unknown as EventEnvelope;
}
