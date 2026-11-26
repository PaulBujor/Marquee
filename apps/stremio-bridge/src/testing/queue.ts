import type { InboundMessage } from '../queue';

/** A handle shaped like one the bridge mints, so the consumer's format check accepts it. */
export const VALID_HANDLE = `sbr_${'A'.repeat(43)}`;

/** The `createdAt` the tests' bridge record carries; a message must repeat it to be delivered. */
export const PAIRED_AT = new Date(0).toISOString();

/** The slice of `Queue` the bridge uses — `send` — recording everything sent, optionally failing. */
export function fakeQueue(options: { fail?: boolean } = {}): {
	binding: Queue;
	sent: InboundMessage[];
} {
	const sent: InboundMessage[] = [];

	// SAFETY: the bridge only calls `send`; `sendBatch` exists so the shape is recognisably a
	// Queue. Nothing else on the interface is reached from src/.
	const binding = {
		send: async (body: InboundMessage) => {
			if (options.fail) throw new Error('queue unavailable');
			sent.push(body);
		},
		sendBatch: async () => {}
	} as unknown as Queue;

	return { binding, sent };
}

export interface FakeMessage {
	body: InboundMessage;
	attempts: number;
	acked: boolean;
	retried: boolean;
	/** The delay the consumer asked for, so the backoff is assertable rather than invisible. */
	retryDelaySeconds?: number;
	ack(): void;
	retry(options?: { delaySeconds?: number }): void;
}

export function inboundBody(overrides: Partial<InboundMessage> = {}): InboundMessage {
	return {
		handle: VALID_HANDLE,
		pairedAt: PAIRED_AT,
		type: 'movie',
		id: 'tt0133093',
		action: 'watched',
		videoIds: [],
		receivedAt: new Date(0).toISOString(),
		...overrides
	};
}

export function inboundMessage(overrides: Partial<InboundMessage> = {}, attempts = 1): FakeMessage {
	const message: FakeMessage = {
		body: inboundBody(overrides),
		attempts,
		acked: false,
		retried: false,
		ack() {
			message.acked = true;
			message.retried = false;
		},
		retry(options) {
			message.retryDelaySeconds = options?.delaySeconds;
			message.retried = true;
			message.acked = false;
		}
	};

	return message;
}

/** A batch as Cloudflare would hand it to `queue()`. */
export function inboundBatch(messages: FakeMessage[]): MessageBatch<InboundMessage> {
	// SAFETY: `consume` reads `messages` and uses only body, attempts, ack and retry on each.
	return { queue: 'marquee-stremio-inbound', messages } as unknown as MessageBatch<InboundMessage>;
}
