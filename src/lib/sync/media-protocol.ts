/**
 * Wire contract for `POST /api/media/sync` — the media reference channel, separate from the events
 * channel (`/api/sync`). Client-safe (shared by the endpoint and the client engine).
 */
import { z } from 'zod';
import { MEDIA_PROVIDERS, type MediaRecord } from './events';

/** Max identity refs / have-entries accepted in one media-sync call. */
export const MEDIA_SYNC_MAX = 500;

/**
 * `refs` are identity hints for titles the client has (so the server can hydrate + store them);
 * `have` reports the `version` the client holds per media id. The server replies with the rows the
 * client is missing or behind on (server version > client version), and only touches ids the user's
 * own events reference.
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
