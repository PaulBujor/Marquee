/**
 * Internal queue abstraction. Domain code (media refresh) depends only on these interfaces, never
 * on a specific transport's types — a Cloudflare Queues adapter is the only implementation today
 * (`./cloudflare.ts`), a Scaleway/SQS adapter can be added later without touching the domain code.
 */

/** Sends batches of messages onto a queue. */
export interface QueueProducer<T> {
	enqueueBatch(items: T[]): Promise<void>;
}

/** A single delivery of a message, with the transport's own delivery-attempt count. */
export interface QueueEnvelope<T> {
	body: T;
	/** 1-based delivery attempt count, as reported by the transport. */
	attempts: number;
}

/** What to do with a delivered message: remove it from the queue, or redeliver it later. */
export type QueueOutcome = 'ack' | 'retry';

/**
 * Processes a batch of deliveries and decides each one's outcome. Implementations own their own
 * give-up/attempt-cap policy so behavior doesn't depend on a transport's native retry/DLQ
 * semantics (Cloudflare Queues and SQS express those differently) — a transport adapter's job is
 * only to relay the returned outcomes back to the real messages (ack vs. redeliver).
 */
export interface QueueConsumer<T> {
	processBatch(envelopes: QueueEnvelope<T>[]): Promise<QueueOutcome[]>;
}
