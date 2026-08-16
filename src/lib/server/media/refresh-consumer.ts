/**
 * Consumer side of the media-refresh queue: given a batch of `MediaRefreshMessage` deliveries,
 * refresh each title and decide its `QueueOutcome`. Transport-agnostic — takes plain
 * `QueueEnvelope`s, not a Cloudflare `MessageBatch`, so it runs the same whether it's invoked from
 * the real queue consumer (via `POST /api/queue/media-refresh`, see that route) or a test.
 *
 * Titles are processed one at a time (not `Promise.all`), matching the rest of the media-refresh
 * code (`cron.ts`, `sync.ts`). That bounds *titles* in flight, not TMDB requests: `refreshMedia`
 * fans a show's season fetches out with `Promise.all`, so one long-running series can issue dozens
 * of concurrent calls. Peak TMDB load is therefore roughly `max_concurrency` × the season count of
 * the widest title in flight — not `max_concurrency` — which is what to reason about before
 * raising either number in wrangler.jsonc.
 */
import type { createDb } from '$lib/server/db';
import type { MediaProvider } from '$lib/sync/events';
import type { TmdbClient } from '$lib/server/tmdb';
import { refreshMedia } from './hydrate';
import type { QueueEnvelope, QueueOutcome } from '$lib/server/queue/types';

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
 *
 * Note the counter is the transport's, and it counts *deliveries*, not failures this code saw: a
 * batch that died before reaching the route (a bad `CRON_SECRET`, a non-JSON 500) is retried whole,
 * incrementing every message's `attempts` without any of them having been tried on their own
 * merits. The gap to `max_retries` is wide enough to absorb a few of those before a title that
 * never genuinely failed gets dropped. Making this exact would need a per-title attempt count in
 * durable state; the message body can't carry one, since a redelivery replays the original body.
 */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** Refreshes every message in a batch and returns one outcome per message, in order. */
export async function processMediaRefreshBatch(
	db: Db,
	tmdb: TmdbHydrator,
	envelopes: QueueEnvelope<MediaRefreshMessage>[],
	now: number = Date.now()
): Promise<QueueOutcome[]> {
	const outcomes: QueueOutcome[] = [];
	let refreshed = 0;
	let retrying = 0;
	let dropped = 0;
	for (const envelope of envelopes) {
		const { provider, externalId, force } = envelope.body;
		try {
			await refreshMedia(db, tmdb, provider, externalId, now, force ?? false);
			outcomes.push('ack');
			refreshed++;
		} catch (err) {
			const giveUp = envelope.attempts >= MAX_DELIVERY_ATTEMPTS;
			console.error(
				`media-refresh queue: failed ${provider}:${externalId} ` +
					`(attempt ${envelope.attempts}${giveUp ? ', giving up' : ', will retry'})`,
				err
			);
			outcomes.push(giveUp ? 'ack' : 'retry');
			if (giveUp) dropped++;
			else retrying++;
		}
	}
	// One line per batch, always — the drain is otherwise invisible, and a queue that acks nothing
	// but no-ops would look identical to a healthy one from the enqueue-side log alone.
	console.log(
		`media-refresh queue: batch of ${envelopes.length} — ${refreshed} refreshed, ` +
			`${retrying} retrying, ${dropped} dropped`
	);
	return outcomes;
}
