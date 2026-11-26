import type { InboundMessage } from '../queue';

/** The slice of `Queue` the bridge uses — `send` — recording everything sent. */
export function fakeQueue(): { binding: Queue; sent: InboundMessage[] } {
	const sent: InboundMessage[] = [];

	// SAFETY: the bridge only calls `send`; `sendBatch` exists so the shape is recognisably a
	// Queue. Nothing else on the interface is reached from src/.
	const binding = {
		send: async (body: InboundMessage) => {
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
	ack(): void;
	retry(options?: { delaySeconds?: number }): void;
}

/** The body alone, for driving `deliver` directly. */
export function inboundBody(overrides: Partial<InboundMessage> = {}): InboundMessage {
	return {
		handle: 'sbr_test',
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
		retry() {
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
