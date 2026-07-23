/**
 * Wire contract for `POST /api/media/sync` — the media reference channel, separate from the
 * events channel (`/api/sync`). The client sends identity only; the server derives our id and
 * hydrates from TMDB (see MRQ-111a). Client-safe (shared by the endpoint and the client engine).
 */
import { z } from 'zod';
import { MEDIA_PROVIDERS, type MediaRecord } from './events';

/** Max identity refs / needed ids accepted in one media-sync call. */
export const MEDIA_SYNC_MAX = 500;

/**
 * Request body: `refs` are identity hints for media the client has (so the server can hydrate
 * + store them), `need` are our media ids the client references but lacks locally (returned if
 * the server already has them). The server only acts on ids the user's own events reference.
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
	need: z.array(z.string().min(1)).max(MEDIA_SYNC_MAX)
});

export type MediaSyncRequest = z.infer<typeof mediaSyncRequestSchema>;

export interface MediaSyncResponse {
	media: MediaRecord[];
}
