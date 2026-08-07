import { describe, expect, it } from 'vitest';
import type { QueueConsumer, QueueEnvelope, QueueOutcome } from './types';
import { createMemoryQueue } from './memory';

/** A consumer that acks even ids, retries odd ids — enough to prove outcomes flow through. */
function evenOddConsumer(): QueueConsumer<number> {
	return {
		async processBatch(envelopes) {
			return envelopes.map((e): QueueOutcome => (e.body % 2 === 0 ? 'ack' : 'retry'));
		}
	};
}

describe('the queue abstraction is swappable', () => {
	it('a QueueProducer implementation composes with any QueueConsumer, sight unseen', async () => {
		const queue = createMemoryQueue<number>();
		await queue.enqueueBatch([1, 2, 3, 4]);
		expect(queue.items).toEqual([1, 2, 3, 4]);

		const envelopes: QueueEnvelope<number>[] = queue.items.map((body) => ({ body, attempts: 1 }));
		const outcomes = await evenOddConsumer().processBatch(envelopes);

		expect(outcomes).toEqual(['retry', 'ack', 'retry', 'ack']);
	});

	it('enqueueBatch is additive across multiple calls, like Cloudflare Queues sendBatch', async () => {
		const queue = createMemoryQueue<string>();
		await queue.enqueueBatch(['a', 'b']);
		await queue.enqueueBatch(['c']);
		expect(queue.items).toEqual(['a', 'b', 'c']);
	});
});
