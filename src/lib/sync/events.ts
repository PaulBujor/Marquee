/**
 * Canonical event model for the event-sourced sync pipeline.
 *
 * The event log is the single source of truth: both the server's D1 materialized
 * tables and the client's IndexedDB materialized stores are *projections* of the
 * same events defined here. This module is **client-safe** — no server-only
 * imports — so it can be imported from both `src/lib/server` and browser code.
 */
import { z } from 'zod';
import { v5 as uuidv5 } from 'uuid';

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
 * media metadata is separate reference data (see {@link MediaRecord}). `tracking.*`
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

/** A season's episode count — the minimum a show needs for progress / next-episode. */
export interface MediaSeason {
	seasonNumber: number;
	episodeCount: number;
}

/**
 * A media reference record — the shared shape of the server `media` row, the client media
 * store, and the media-channel DTO. Media is *reference data*, synced on a separate parallel
 * channel (MRQ-111) — **never** inside `/api/sync`, which carries events only. Events refer
 * to a title by `entityId` (this `id`), never by embedding this. `id` is our provider-agnostic
 * media id ({@link mediaId}); TMDB stays the real source, this is the display cache clients hold
 * for offline rendering. `seasons` is null for movies.
 */
export interface MediaRecord {
	id: string;
	provider: MediaProvider;
	/** The provider's id (e.g. `movie/603`); null for purely-custom media. */
	externalId: string | null;
	source: MediaSource;
	type: 'movie' | 'show';
	title: string;
	year: number | null;
	posterPath: string | null;
	backdropPath: string | null;
	overview: string;
	seasons: MediaSeason[] | null;
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

/** Any event payload — the union of all per-type shapes (used to type the stored JSON column). */
export type EventPayload = EventPayloadMap[SyncEventType];

/**
 * An event as produced and stored by a client. `id` is a client-generated UUID that
 * doubles as the global dedup key; `entityId` is the deterministic `mediaId` the event
 * targets. The client never sets `userId`/`sequence` — the server assigns those on persist.
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

/** Metadata providers we can hydrate a title from. Custom (user-authored) media is a separate, deferred concern. */
export const MEDIA_PROVIDERS = ['tmdb'] as const;
export type MediaProvider = (typeof MEDIA_PROVIDERS)[number];

/**
 * How a media row is sourced: `linked` = provider-backed (shareable/crowdsourced),
 * `custom` = user-authored (private). Only `linked` rows are ever surfaced to other users.
 */
export const MEDIA_SOURCES = ['linked', 'custom'] as const;
export type MediaSource = (typeof MEDIA_SOURCES)[number];

/**
 * Fixed UUIDv5 namespace for Marquee media ids. **Never change this** — it would
 * repoint every derived media id and orphan the events that reference them.
 */
const MEDIA_ID_NAMESPACE = 'b7c8e9a0-3f2d-4c1b-9e6a-8d5f4a2b1c0e';

/**
 * Our own, **provider-agnostic** media id: a deterministic UUIDv5 derived from
 * `(provider, externalId)`. Every device derives the same id offline with no
 * coordination, and switching providers (or becoming our own) needs no remap.
 */
export function mediaId(provider: MediaProvider, externalId: string): string {
	return uuidv5(`${provider}:${externalId}`, MEDIA_ID_NAMESPACE);
}

/**
 * TMDB's stable external id for a title — `${type}/${tmdbId}`. TMDB numbers movies
 * and shows independently, so the bare number is ambiguous; the type disambiguates.
 */
export function tmdbExternalId(type: 'movie' | 'show', tmdbId: number): string {
	return `${type}/${tmdbId}`;
}

/** Convenience: our media id for a TMDB-sourced title. */
export function tmdbMediaId(type: 'movie' | 'show', tmdbId: number): string {
	return mediaId('tmdb', tmdbExternalId(type, tmdbId));
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
