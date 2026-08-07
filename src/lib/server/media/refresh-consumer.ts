/**
 * Consumer side of the media-refresh queue: given a batch of `MediaRefreshMessage` deliveries,
 * refresh each title and decide its `QueueOutcome`. Transport-agnostic — takes plain
 * `QueueEnvelope`s, not a Cloudflare `MessageBatch`, so it runs the same whether it's invoked from
 * the real queue consumer (via `POST /api/queue/media-refresh`, see that route) or a test.
 *
 * Titles are processed sequentially (not `Promise.all`), matching the rest of the media-refresh
 * code (`cron.ts`, `sync.ts`) — TMDB concurrency per invocation stays at 1, so the wrangler.jsonc
 * consumer's `max_concurrency` is the only place overall concurrency is tuned.
 */
import type { createDb } from '$lib/server/db';
import type { MediaProvider } from '$lib/sync/events';
import type { TmdbClient } from '$lib/server/tmdb';
import { refreshMedia } from './hydrate';
import type { QueueConsumer, QueueEnvelope, QueueOutcome } from '$lib/server/queue/types';

type Db = ReturnType<typeof createDb>;
type TmdbHydrator = Pick<TmdbClient, 'getDetails' | 'getSeason'>;

export interface MediaRefreshMessage {
	provider: MediaProvider;
	externalId: string;
	/** Bypasses `refreshMedia`'s TTL, carried through from a `?force=1` enqueue. */
	force?: boolean;
}

/**
 * Give up after this many delivery attempts and `ack` (drop) rather than `retry` — a title whose
 * TMDB hydration keeps failing (bad data, a persistently-erroring season) must not spin forever.
 * Deliberately lower than the Cloudflare Queues consumer's own `max_retries` (wrangler.jsonc) so
 * *this* decision is what ends the loop; Cloudflare's own retry/DLQ is only a backstop for cases
 * this code never got to run at all (e.g. the self-fetch itself throwing).
 */
export const MAX_DELIVERY_ATTEMPTS = 3;

/** Refreshes every message in a batch and returns one outcome per message, in order. */
export async function processMediaRefreshBatch(
	db: Db,
	tmdb: TmdbHydrator,
	envelopes: QueueEnvelope<MediaRefreshMessage>[],
	now: number = Date.now()
): Promise<QueueOutcome[]> {
	const outcomes: QueueOutcome[] = [];
	for (const envelope of envelopes) {
		const { provider, externalId, force } = envelope.body;
		try {
			await refreshMedia(db, tmdb, provider, externalId, now, force ?? false);
			outcomes.push('ack');
		} catch (err) {
			const giveUp = envelope.attempts >= MAX_DELIVERY_ATTEMPTS;
			console.error(
				`media-refresh queue: failed ${provider}:${externalId} ` +
					`(attempt ${envelope.attempts}${giveUp ? ', giving up' : ', will retry'})`,
				err
			);
			outcomes.push(giveUp ? 'ack' : 'retry');
		}
	}
	return outcomes;
}

/** `QueueConsumer<MediaRefreshMessage>` bound to a db/TMDB client — what the abstraction expects. */
export function mediaRefreshConsumer(
	db: Db,
	tmdb: TmdbHydrator,
	now: number = Date.now()
): QueueConsumer<MediaRefreshMessage> {
	return { processBatch: (envelopes) => processMediaRefreshBatch(db, tmdb, envelopes, now) };
}
