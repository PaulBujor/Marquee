// Only this file may reference Cloudflare's `Queue`/`MessageBatch` types; the `queue()` handler in scripts/append-cron.mjs relays batches over HTTP instead.
import { chunkBySize } from '#lib/server/db/chunk.js';
import type { QueueProducer } from './types';

/** Cloudflare Queues caps `sendBatch` at 100 messages per call. */
export const CLOUDFLARE_SEND_BATCH_MAX = 100;

export function cloudflareQueueProducer<T>(queue: Queue<T>): QueueProducer<T> {
	return {
		async enqueueBatch(items) {
			// `chunkBySize` yields no chunks for an empty input, so an empty enqueue sends nothing.
			for (const part of chunkBySize(items, CLOUDFLARE_SEND_BATCH_MAX)) {
				await queue.sendBatch(part.map((body) => ({ body })));
			}
		}
	};
}
