/**
 * Cloudflare Queues adapter for the internal queue abstraction (`./types.ts`). This is the only
 * file in the media-refresh path allowed to reference Cloudflare's `Queue`/`MessageBatch` types —
 * everything else (the enqueue step, the batch consumer) is written against `QueueProducer`
 * `QueueEnvelope` alone, so swapping the transport later (Scaleway/SQS) means writing a sibling
 * adapter here, not touching the domain code.
 *
 * There's no consumer-side adapter here: Cloudflare only delivers a `MessageBatch` to a `queue()`
 * export on the worker itself (see `scripts/append-cron.mjs`), which can't import this module (the
 * adapter-generated worker has no build step of its own — see that script's header comment). That
 * handler instead relays each batch to `POST /api/queue/media-refresh` and applies the
 * `QueueOutcome[]` it gets back to the real `Message` objects — the mechanical Cloudflare-specific
 * half of the consumer adapter lives there, in plain JS, for the same reason `scheduled` self-fetches
 * instead of importing app code directly.
 */
import type { QueueProducer } from './types';

/** Cloudflare Queues caps `sendBatch` at 100 messages per call. */
export const CLOUDFLARE_SEND_BATCH_MAX = 100;

function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	return chunks;
}

/** Wraps a Cloudflare Queues producer binding as a `QueueProducer`. */
export function cloudflareQueueProducer<T>(queue: Queue<T>): QueueProducer<T> {
	return {
		async enqueueBatch(items) {
			for (const part of chunk(items, CLOUDFLARE_SEND_BATCH_MAX)) {
				if (part.length === 0) continue;
				await queue.sendBatch(part.map((body) => ({ body })));
			}
		}
	};
}
