/**
 * Wire contract for `POST /api/media/sync` — the media reference channel, separate from the
 * events channel (`/api/sync`). The client sends identity only; the server derives our id and
 * hydrates from TMDB (see MRQ-111a). Client-safe (shared by the endpoint and the client engine).
 */
import { z } from 'zod';
import { MEDIA_PROVIDERS, type MediaRecord } from './events';

/** Max identity refs / have-entries accepted in one media-sync call. */
export const MEDIA_SYNC_MAX = 500;

/**
 * Request body: `refs` are identity hints for media the client has (so the server can hydrate
 * + store them), `have` reports each media id the client references locally with the `version`
 * it holds. The server returns rows the client is **missing OR behind on** (server version >
 * client version) — the version-diff staleness signal (MRQ-122), so a refreshed row propagates
 * without the old "re-pull everything" heuristic. The server only acts on ids the user's own
 * events reference (anti-abuse).
 */
export const mediaSyncRequestSchema = z.object({
	refs: z
		.array(
			z.object({
				provider: z.enum(MEDIA_PROVIDERS),
				externalId: z.string().min(1).max(128)
			})
		)
		.max(MEDIA_SYNC_MAX),
	have: z
		.array(z.object({ id: z.string().min(1), version: z.number().int().nonnegative() }))
		.max(MEDIA_SYNC_MAX)
});

export type MediaSyncRequest = z.infer<typeof mediaSyncRequestSchema>;

export interface MediaSyncResponse {
	media: MediaRecord[];
}
