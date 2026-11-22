export interface QueueProducer<T> {
	enqueueBatch(items: T[]): Promise<void>;
}

export interface QueueEnvelope<T> {
	body: T;
	/** 1-based delivery attempt count, as reported by the transport. */
	attempts: number;
}

export type QueueOutcome = 'ack' | 'retry';

// Implementations own their give-up policy: Cloudflare Queues and SQS express retry/DLQ semantics differently.
export interface QueueConsumer<T> {
	processBatch(envelopes: QueueEnvelope<T>[]): Promise<QueueOutcome[]>;
}
