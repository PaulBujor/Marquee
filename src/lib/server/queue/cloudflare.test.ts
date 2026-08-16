import { describe, expect, it, vi } from 'vitest';
import { CLOUDFLARE_SEND_BATCH_MAX, cloudflareQueueProducer } from './cloudflare';

/** Minimal stand-in for the Cloudflare `Queue<T>` binding — only `sendBatch` is used. */
function fakeQueue() {
	const calls: unknown[][] = [];
	return {
		calls,
		binding: {
			async sendBatch(messages: Iterable<{ body: unknown }>) {
				calls.push([...messages]);
				return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
			}
		}
	};
}

describe('cloudflareQueueProducer', () => {
	it('wraps each item as { body } and forwards to sendBatch', async () => {
		const { calls, binding } = fakeQueue();
		const producer = cloudflareQueueProducer(binding as never);

		await producer.enqueueBatch(['a', 'b']);

		expect(calls).toEqual([[{ body: 'a' }, { body: 'b' }]]);
	});

	it('chunks batches larger than the Cloudflare Queues sendBatch limit', async () => {
		const { calls, binding } = fakeQueue();
		const producer = cloudflareQueueProducer(binding as never);
		const items = Array.from({ length: CLOUDFLARE_SEND_BATCH_MAX + 1 }, (_, i) => i);

		await producer.enqueueBatch(items);

		expect(calls).toHaveLength(2);
		expect(calls[0]).toHaveLength(CLOUDFLARE_SEND_BATCH_MAX);
		expect(calls[1]).toHaveLength(1);
	});

	// Contract, not an accident of the loop: `chunkBySize` yields no chunks for an empty input, so
	// an empty enqueue must not reach the transport at all.
	it('does not call sendBatch for an empty batch', async () => {
		const sendBatch = vi.fn();
		const producer = cloudflareQueueProducer({ sendBatch } as never);

		await producer.enqueueBatch([]);

		expect(sendBatch).not.toHaveBeenCalled();
	});
});
