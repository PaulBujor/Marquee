/**
 * In-memory `QueueProducer` — no Cloudflare Queues involved. Exists to prove the abstraction in
 * `./types.ts` is swappable (see `memory.test.ts`): domain code that only depends on
 * `QueueProducer`/`QueueConsumer` works identically against this and against the Cloudflare
 * adapter, which is exactly the property a future Scaleway/SQS adapter relies on.
 */
import type { QueueProducer } from './types';

export interface MemoryQueue<T> extends QueueProducer<T> {
	readonly items: T[];
}

export function createMemoryQueue<T>(): MemoryQueue<T> {
	const items: T[] = [];
	return {
		items,
		async enqueueBatch(batch) {
			items.push(...batch);
		}
	};
}
