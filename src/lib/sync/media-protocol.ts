/**
 * Wire contract for `POST /api/media/sync`. Provider-backed titles travel as `refs` (identity
 * only); user-authored titles travel as `custom` (whole records), scoped to their owner.
 */
import { z } from 'zod';
import { HYDRATABLE_PROVIDERS, type MediaRecord } from './events';
import {
	CUSTOM_MAX_EPISODES_TOTAL,
	CUSTOM_MAX_SEASONS,
	CUSTOM_MAX_YEAR,
	CUSTOM_MIN_YEAR,
	CUSTOM_OVERVIEW_MAX,
	CUSTOM_TITLE_MAX
} from '$lib/validation/custom-media';

/** Max identity refs / have-entries accepted in one media-sync call. */
export const MEDIA_SYNC_MAX = 500;

/** Max custom records per call (each carries a full seasons/episodes payload). */
export const MEDIA_SYNC_CUSTOM_MAX = 25;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
/** `YYYY-MM-DD`, the only date shape anything in the media model stores. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Same bound the event envelope puts on a client clock (below Jan 1 2100). */
const clientClock = z.number().int().positive().lt(4102444800000);

const customSeasonSchema = z.object({
	seasonNumber: z.number().int().nonnegative(),
	name: z.string().max(CUSTOM_TITLE_MAX),
	overview: z.string().max(CUSTOM_OVERVIEW_MAX),
	airDate: isoDate.nullable(),
	posterPath: z.null(),
	episodeCount: z.number().int().nonnegative()
});

const customEpisodeSchema = z.object({
	season: z.number().int().nonnegative(),
	episode: z.number().int().positive(),
	name: z.string().max(CUSTOM_TITLE_MAX),
	overview: z.string().max(CUSTOM_OVERVIEW_MAX),
	airDate: isoDate.nullable(),
	runtime: z.number().int().positive().nullable(),
	stillPath: z.null()
});

/** User-authored record on the wire. Pinned to `local` provider, no external id, no artwork. */
export const customMediaPushSchema = z.object({
	id: uuid,
	provider: z.literal('local'),
	externalId: z.null(),
	source: z.literal('custom'),
	type: z.enum(['movie', 'show']),
	title: z.string().min(1).max(CUSTOM_TITLE_MAX),
	year: z.number().int().min(CUSTOM_MIN_YEAR).max(CUSTOM_MAX_YEAR).nullable(),
	// Artwork lives at provider paths we proxy; a custom entry has none.
	posterPath: z.null(),
	backdropPath: z.null(),
	overview: z.string().max(CUSTOM_OVERVIEW_MAX),
	genres: z.array(z.string().max(64)).max(16),
	releaseDate: isoDate.nullable(),
	// `status` is TMDB's own production status — meaningless for an entry TMDB has never seen.
	status: z.null(),
	inProduction: z.boolean().nullable(),
	firstAirDate: isoDate.nullable(),
	lastAirDate: isoDate.nullable(),
	version: z.number().int().nonnegative(),
	seasons: z.array(customSeasonSchema).max(CUSTOM_MAX_SEASONS).nullable(),
	episodes: z.array(customEpisodeSchema).max(CUSTOM_MAX_EPISODES_TOTAL).nullable(),
	/** Epoch ms of the author's last local edit — the LWW clock, stored as the row's `updatedAt`. */
	editedAt: clientClock
});

/** Custom record as the client assembles it (wide `MediaRecord` + edit clock). */
export interface CustomMediaPush extends MediaRecord {
	editedAt: number;
}

/** Custom record after validation — the exact shape the endpoint accepts. */
export type ValidatedCustomMedia = z.infer<typeof customMediaPushSchema>;

/**
 * `refs` are identity hints for hydration; `have` reports the client's version per id. The server
 * replies with rows the client is missing or behind on.
 */
export const mediaSyncRequestSchema = z.object({
	// A ref exists so the server can hydrate the title, so only external providers belong here —
	// user-authored (`local`) media has nothing to hydrate from and travels as `custom` instead.
	refs: z
		.array(
			z.object({
				provider: z.enum(HYDRATABLE_PROVIDERS),
				externalId: z.string().min(1).max(128)
			})
		)
		.max(MEDIA_SYNC_MAX),
	have: z
		.array(z.object({ id: z.string().min(1), version: z.number().int().nonnegative() }))
		.max(MEDIA_SYNC_MAX),
	/** Locally-authored rows to back up. Absent on a client that has none (the common case). */
	custom: z.array(customMediaPushSchema).max(MEDIA_SYNC_CUSTOM_MAX).optional()
});

export type MediaSyncRequest = z.infer<typeof mediaSyncRequestSchema>;

export interface MediaSyncResponse {
	media: MediaRecord[];
	/** True when the server capped per-request TMDB work and the client should sync again to drain. */
	pending?: boolean;
	/** Ids from `custom` the server actually stored. Skipped records stay queued for retry. */
	storedCustom?: string[];
}
