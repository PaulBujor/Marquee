/** Peak TMDB load is `max_concurrency` × the widest title's season count — `refreshMedia` fans seasons out. */
import type { createDb } from '#lib/server/db/index.js';
import type { MediaProvider } from '#lib/sync/events.js';
import type { TmdbClient } from '#lib/server/tmdb/index.js';
import { refreshMedia } from './hydrate';
import type { QueueEnvelope, QueueOutcome } from '#lib/server/queue/types.js';

type Db = ReturnType<typeof createDb>;
type TmdbHydrator = Pick<TmdbClient, 'getDetails' | 'getSeason'>;

export interface MediaRefreshMessage {
	provider: MediaProvider;
	externalId: string;
	force?: boolean;
}

/** Deliberately below the Cloudflare consumer's max_retries, so *this* decision ends the loop and CF's retry/DLQ stays a backstop. */
export const MAX_DELIVERY_ATTEMPTS = 5;

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
	// One line per batch, always — a queue that acks nothing but no-ops would look healthy from the enqueue-side log alone.
	console.log(
		`media-refresh queue: batch of ${envelopes.length} — ${refreshed} refreshed, ` +
			`${retrying} retrying, ${dropped} dropped`
	);
	return outcomes;
}
