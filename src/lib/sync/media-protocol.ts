/**
 * Wire contract for `POST /api/media/sync` — the media reference channel, separate from the events
 * channel (`/api/sync`). Client-safe (shared by the endpoint and the client engine).
 *
 * The channel is asymmetric on purpose. Provider-backed titles travel as **identity only** (`refs`)
 * and the server hydrates them, so a shared row can't be poisoned with client-supplied metadata.
 * User-authored titles have no such source — nobody but the author knows what they are — so they
 * travel as **whole records** (`custom`) and the server stores them verbatim, scoped to their owner.
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

/**
 * Max whole custom records accepted in one call. Far smaller than {@link MEDIA_SYNC_MAX} because
 * each one carries its full seasons/episodes payload rather than a 40-byte identity pair.
 */
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

/**
 * A user-authored record on the wire. Pinned to exactly the shape our own writer produces — a
 * `local` provider, no external id, no provider artwork paths — so the endpoint can never be talked
 * into stashing something that would later read as a shared, provider-backed row.
 */
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

/**
 * A custom record as the client assembles it: the shared media shape plus the edit clock that
 * orders two devices' edits. Deliberately the *wide* `MediaRecord` types — it is what a local row
 * reads back as. {@link customMediaPushSchema} is the narrow gate both sides run it through, so a
 * local row that somehow isn't a well-formed custom entry is caught before it's sent, not after.
 */
export interface CustomMediaPush extends MediaRecord {
	editedAt: number;
}

/**
 * A custom record **after** validation — the exact shape the endpoint accepts and the server
 * stores. Narrower than {@link CustomMediaPush} on every field the contract pins, so code holding
 * one of these has already proved it isn't a provider-backed row wearing a custom label.
 */
export type ValidatedCustomMedia = z.infer<typeof customMediaPushSchema>;

/**
 * `refs` are identity hints for titles the client has (so the server can hydrate + store them);
 * `have` reports the `version` the client holds per media id. The server replies with the rows the
 * client is missing or behind on (server version > client version), and only touches ids the user's
 * own events reference.
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
	/**
	 * True when more referenced titles still need hydration/refresh than the server processed this
	 * request (it caps per-request TMDB work to stay under the Worker CPU limit). The client should
	 * sync again to drain the backlog; absent/false means everything is caught up.
	 */
	pending?: boolean;
	/**
	 * Ids from `custom` the server actually stored. Reported rather than assumed: a record the
	 * request wasn't entitled to write, or one a newer stored copy beat, is skipped — and the
	 * client must keep those marked for a later attempt instead of dropping the edit.
	 */
	storedCustom?: string[];
}
