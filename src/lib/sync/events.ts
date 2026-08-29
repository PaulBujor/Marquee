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
 * Event types. `tracking.*` are watchlist lifecycle events; `episode.*` are per-episode watched
 * state; `media.*` record identity decisions about a title's provider link.
 */
export const SYNC_EVENT_TYPES = [
	'tracking.added',
	'tracking.status_changed',
	'tracking.favorite_toggled',
	'tracking.rated',
	'tracking.removed',
	'episode.watched',
	'episode.unwatched',
	'media.linked',
	'media.match_declined'
] as const;
export type SyncEventType = (typeof SYNC_EVENT_TYPES)[number];

/** A show's season, nested in a {@link MediaRecord}. */
export interface MediaSeason {
	seasonNumber: number;
	name: string;
	overview: string;
	/** `YYYY-MM-DD`, or null. */
	airDate: string | null;
	posterPath: string | null;
	episodeCount: number;
}

/**
 * A show's episode, nested in a {@link MediaRecord}. A null `airDate` means it hasn't aired yet
 * (unannounced or future), so it isn't watchable.
 */
export interface MediaEpisode {
	season: number;
	episode: number;
	name: string;
	overview: string;
	/** `YYYY-MM-DD`, or null when not yet scheduled. */
	airDate: string | null;
	runtime: number | null;
	stillPath: string | null;
}

/**
 * Media reference data — the shared shape of the server `media` row, client cache, and media-channel
 * payload. Events reference a title by `id` and never embed it. `version` is bumped on refresh so
 * clients can spot a stale copy.
 */
export interface MediaRecord {
	/** Derived from `(provider, externalId)` for provider-backed titles; random for custom media. */
	id: string;
	provider: MediaProvider;
	/** The provider's own id, e.g. `movie/603`; null for custom media. */
	externalId: string | null;
	source: MediaSource;
	type: 'movie' | 'show';
	title: string;
	year: number | null;
	posterPath: string | null;
	backdropPath: string | null;
	overview: string;
	genres: string[];
	/** `YYYY-MM-DD`. Movies only. */
	releaseDate: string | null;
	/** TMDB status, e.g. `Returning Series` / `Ended`. Shows only. */
	status: string | null;
	/** Shows only. */
	inProduction: boolean | null;
	/** `YYYY-MM-DD`. Shows only. */
	firstAirDate: string | null;
	/** `YYYY-MM-DD`. Shows only. */
	lastAirDate: string | null;
	version: number;
	/** Null for movies. */
	seasons: MediaSeason[] | null;
	/** Null for movies. */
	episodes: MediaEpisode[] | null;
	/**
	 * Cast and crew. `null` means *not known* — a scalar-only snapshot that mustn't overwrite
	 * credits already stored — while `[]` means *known to have none*. Same convention as
	 * `seasons`/`episodes`, and the reason a quick-add can't blank a synced title's cast.
	 */
	credits: MediaCredit[] | null;
}

/**
 * A single episode coordinate (season + episode number) within a show. The canonical shape for
 * an episode reference across the app — the tracking helpers re-export this rather than redefine it.
 */
export interface EpisodeCoord {
	season: number;
	episode: number;
}

/** Payload shape per event type — the discriminated union that drives projection. */
export interface EventPayloadMap {
	'tracking.added': { status: TrackingStatus };
	'tracking.status_changed': { status: TrackingStatus };
	'tracking.favorite_toggled': { favorite: boolean };
	/** Optional user rating, 1–5; `null` clears it. */
	'tracking.rated': { rating: number | null };
	'tracking.removed': Record<string, never>;
	'episode.watched': EpisodeCoord;
	'episode.unwatched': EpisodeCoord;
	/**
	 * The user matched `entityId` to a provider-backed title. Target carried as `(provider, externalId)`
	 * alongside `targetId` so a reader can re-derive. A link is an association, never a deletion.
	 */
	'media.linked': { targetId: string; provider: HydratableProvider; externalId: string };
	/** The user dismissed the match suggestions for `entityId`. Syncs so the dismissal holds on every device. */
	'media.match_declined': Record<string, never>;
}

/** Any event payload — the union of all per-type shapes (used to type the stored JSON column). */
export type EventPayload = EventPayloadMap[SyncEventType];

/**
 * An event as produced and stored by a client. `id` is a client-generated UUID; `entityId` is the
 * deterministic media id. Client never sets `userId`/`sequence` — the server assigns those.
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

/**
 * External metadata providers — the ones we can hydrate a title from, and so the only ones a
 * `refs` identity or a link target may name.
 */
export const HYDRATABLE_PROVIDERS = ['tmdb'] as const;
export type HydratableProvider = (typeof HYDRATABLE_PROVIDERS)[number];

/**
 * Where a media row's metadata comes from. `local` is user-authored (custom) media: nobody
 * hydrates it, it carries no `externalId`, and its id is random rather than derived. Keeping it
 * in the same enum means `provider` never lies about a row's origin.
 */
export const MEDIA_PROVIDERS = [...HYDRATABLE_PROVIDERS, 'local'] as const;
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
 * Provider-agnostic media id: a deterministic UUIDv5 from `(provider, externalId)`. Every device
 * derives the same id offline. Custom media mints a random id instead, so the parameter is the
 * narrower {@link HydratableProvider}.
 */
export function mediaId(provider: HydratableProvider, externalId: string): string {
	return uuidv5(`${provider}:${externalId}`, MEDIA_ID_NAMESPACE);
}

/** Narrows an untrusted/stored provider value to one we can hydrate from. */
export function isHydratableProvider(
	provider: string | null | undefined
): provider is HydratableProvider {
	return HYDRATABLE_PROVIDERS.includes(provider as HydratableProvider);
}

/**
 * How a person is credited. `creator` is a show's `created_by`; `director`/`writer` are movie crew.
 * Enum rather than TMDB's free-text job strings, which are inconsistent.
 */
export const CREDIT_ROLES = ['cast', 'director', 'writer', 'producer', 'creator'] as const;
export type CreditRole = (typeof CREDIT_ROLES)[number];

/** One person's credit on a title — shared shape for the `credits` row and its wire record. */
export interface MediaCredit {
	/** Our own person id (see {@link personId}). */
	personId: string;
	/**
	 * The provider's id for them (`person/<tmdbId>`), or null for someone the user typed themselves.
	 * Carried on the wire alongside our own id because our id is a one-way hash — without this a
	 * cached credit could show a name but never link to that person's page offline.
	 */
	externalId: string | null;
	name: string;
	profilePath: string | null;
	role: CreditRole;
	/** Who they played; cast only. */
	character: string | null;
	/** Billing order within the role, so a rebuilt list matches how the provider ranked it. */
	sortOrder: number;
}

/** TMDB external id for a person — namespaced as `person/${tmdbId}` to avoid collisions with titles. */
export function personExternalId(tmdbId: number): string {
	return `person/${tmdbId}`;
}

/** Our own id for a provider-backed person, derived the same way a title's is. */
export function personId(provider: HydratableProvider, tmdbId: number): string {
	return mediaId(provider, personExternalId(tmdbId));
}

/** Recover the provider's numeric person id from {@link personExternalId}, or null if it isn't one. */
export function parsePersonExternalId(externalId: string | null): number | null {
	const match = /^person\/(\d+)$/.exec(externalId ?? '');
	return match ? Number(match[1]) : null;
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
 * Build a new event, stamping client-owned fields. `clock` defaults to now. Pass an explicit value
 * only when replaying an import — the exported `addedAt` lets events merge by real age, not replay
 * time.
 */
export function createEvent<T extends SyncEventType>(
	type: T,
	entityId: string,
	payload: EventPayloadMap[T],
	deviceId: string,
	clock: number = Date.now()
): EventEnvelope<T> {
	return {
		id: crypto.randomUUID(),
		type,
		entityId,
		payload,
		deviceId,
		clientCreatedAt: clock,
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
	'episode.unwatched': z.object({ season: seasonNumber, episode: episodeNumber }),
	// A link target must be a title someone can actually hydrate, so `local` is not accepted here.
	'media.linked': z.object({
		targetId: uuid,
		provider: z.enum(HYDRATABLE_PROVIDERS),
		externalId: z.string().min(1).max(128)
	}),
	'media.match_declined': z.object({})
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
	}),
	envelopeBase.extend({
		type: z.literal('media.linked'),
		payload: payloadSchemas['media.linked']
	}),
	envelopeBase.extend({
		type: z.literal('media.match_declined'),
		payload: payloadSchemas['media.match_declined']
	})
]);

/** Validate an untrusted event; returns the typed envelope when well-formed, else `null`. */
export function validateEvent(raw: unknown): EventEnvelope | null {
	const result = eventEnvelopeSchema.safeParse(raw);
	return result.success ? (result.data as EventEnvelope) : null;
}
