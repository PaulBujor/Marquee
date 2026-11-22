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
