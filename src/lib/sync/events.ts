/**
 * Canonical event model for the event-sourced sync pipeline.
 *
 * The event log is the single source of truth: both the server's D1 materialized
 * tables and the client's IndexedDB materialized stores are *projections* of the
 * same events defined here. This module is **client-safe** — no server-only
 * imports — so it can be imported from both `src/lib/server` and browser code.
 */
import { z } from 'zod';

/** Bumped when the envelope/payload shapes change, so future events can be migrated. */
export const EVENT_SCHEMA_VERSION = 1;

/** Tracking status for a title on a user's watchlist (`did_not_finish` = started but abandoned). */
export const TRACKING_STATUSES = [
	'want_to_watch',
	'watching',
	'completed',
	'did_not_finish'
] as const;
export type TrackingStatus = (typeof TRACKING_STATUSES)[number];

/**
 * The kinds of events the foundation supports. Events record only *what the user did*;
 * media metadata is separate reference data (see {@link MediaSnapshot}). `tracking.*`
 * are the lifecycle of a watchlist entry, keyed to a title by `entityId` (our media id);
 * `episode.*` are per-episode watched state.
 *
 * Episodes keep a `watched`/`unwatched` pair (a binary toggle reads cleaner than a
 * boolean payload), while `status` is an enum, so it's one `status_changed` carrying
 * the new value rather than an event per status.
 *
 * Future: re-watches (a completed title marked watching again, its episodes re-watched)
 * will need a richer episode model than a single boolean — likely a watch-session or
 * count dimension, added via a `schemaVersion` bump. Not supported yet.
 */
export const SYNC_EVENT_TYPES = [
	'tracking.added',
	'tracking.status_changed',
	'tracking.favorite_toggled',
	'tracking.rated',
	'tracking.removed',
	'episode.watched',
	'episode.unwatched'
] as const;
export type SyncEventType = (typeof SYNC_EVENT_TYPES)[number];

/**
 * A minimal media descriptor. Media is *reference data*, synced on a separate parallel
 * channel (MRQ-111) — **never** inside the `/api/sync` request, which carries events only.
 * Events refer to a title by `entityId` (our media id), never by embedding this. Mirrors
 * `MediaSearchResult` (`src/lib/server/tmdb/types.ts`) — TMDB stays the real source, this is
 * a display cache the client holds for offline rendering.
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
	'tracking.added': { status: TrackingStatus };
	'tracking.status_changed': { status: TrackingStatus };
	'tracking.favorite_toggled': { favorite: boolean };
	/** Optional user rating, 1–5; `null` clears it. */
	'tracking.rated': { rating: number | null };
	'tracking.removed': Record<string, never>;
	'episode.watched': { season: number; episode: number };
	'episode.unwatched': { season: number; episode: number };
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
	/** Per-user monotonic sequence assigned by the server; the sync cursor is the highest pulled. */
	sequence: number;
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

/** Permissive UUID shape (any version) — matches the ids `crypto.randomUUID` emits. */
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/**
 * `clientCreatedAt` is the LWW clock, so a clock set absurdly far ahead would win
 * every future merge. Bound it below Jan 1 2100 (epoch ms) to reject bogus values.
 */
const clientClock = z.number().int().positive().lt(4102444800000);
// Season may be 0 — TMDB numbers Specials as season 0 — but the episode within it is 1-based.
const seasonNumber = z.number().int().nonnegative();
const episodeNumber = z.number().int().positive();

/** Payload schema per event type — the source of truth {@link EventPayloadMap} mirrors. */
const payloadSchemas = {
	'tracking.added': z.object({ status: z.enum(TRACKING_STATUSES) }),
	'tracking.status_changed': z.object({ status: z.enum(TRACKING_STATUSES) }),
	'tracking.favorite_toggled': z.object({ favorite: z.boolean() }),
	'tracking.rated': z.object({ rating: z.number().int().min(1).max(5).nullable() }),
	'tracking.removed': z.object({}),
	'episode.watched': z.object({ season: seasonNumber, episode: episodeNumber }),
	'episode.unwatched': z.object({ season: seasonNumber, episode: episodeNumber })
} as const;

const envelopeBase = z.object({
	id: uuid,
	entityId: z.string().min(1),
	deviceId: uuid,
	clientCreatedAt: clientClock,
	schemaVersion: z.number().int().positive()
});

/**
 * Zod schema for an untrusted event envelope — a discriminated union on `type` so the
 * payload is validated against the matching shape. Shared by the client (early feedback)
 * and the server (authoritative re-validation, per the validate-on-both-sides convention).
 */
export const eventEnvelopeSchema = z.discriminatedUnion('type', [
	envelopeBase.extend({
		type: z.literal('tracking.added'),
		payload: payloadSchemas['tracking.added']
	}),
	envelopeBase.extend({
		type: z.literal('tracking.status_changed'),
		payload: payloadSchemas['tracking.status_changed']
	}),
	envelopeBase.extend({
		type: z.literal('tracking.favorite_toggled'),
		payload: payloadSchemas['tracking.favorite_toggled']
	}),
	envelopeBase.extend({
		type: z.literal('tracking.rated'),
		payload: payloadSchemas['tracking.rated']
	}),
	envelopeBase.extend({
		type: z.literal('tracking.removed'),
		payload: payloadSchemas['tracking.removed']
	}),
	envelopeBase.extend({
		type: z.literal('episode.watched'),
		payload: payloadSchemas['episode.watched']
	}),
	envelopeBase.extend({
		type: z.literal('episode.unwatched'),
		payload: payloadSchemas['episode.unwatched']
	})
]);

/** Validate an untrusted event; returns the typed envelope when well-formed, else `null`. */
export function validateEvent(raw: unknown): EventEnvelope | null {
	const result = eventEnvelopeSchema.safeParse(raw);
	return result.success ? (result.data as EventEnvelope) : null;
}
