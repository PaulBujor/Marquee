/**
 * The inbound write path: a Stremio action becomes one call to Marquee's library API.
 *
 * The addon route only enqueues, so the reply Stremio waits for never depends on Marquee or on
 * TMDB. Delivery is at-least-once, which is safe because the API takes an *intent* and replaying
 * the same one emits nothing the second time.
 */
import type { AddonAction, MediaType } from './addon';
import { readBridge } from './bridges';
import { toIntent } from './intent';

/** One parsed Stremio action, on its way to Marquee. */
export interface InboundMessage {
	handle: string;
	type: MediaType;
	id: string;
	action: AddonAction;
	videoIds: string[];
	/** ISO timestamp of the request, so a stuck message is identifiable in a log. */
	receivedAt: string;
}

/** Past this many deliveries the message is dropped rather than retried forever. */
export const MAX_DELIVERY_ATTEMPTS = 5;

export type Outcome = 'ack' | 'retry';

/**
 * Applies one message. `retry` is reserved for failures that can resolve themselves: a rate limit,
 * an upstream outage, a network error. Anything else — a dead token, an id nobody can resolve, a
 * request Marquee refuses — is `ack`, because a retry would only repeat the same answer.
 */
export async function deliver(env: Env, body: InboundMessage): Promise<Outcome> {
	const bridge = await readBridge(env.BRIDGES, body.handle);
	// Unpaired or rotated away: there is no longer anyone to write for, and no one to tell.
	if (!bridge) {
		console.log(`[queue] ${body.handle} is not paired, dropping`);
		return 'ack';
	}

	const intent = toIntent(body);
	if (!intent) {
		console.warn(`[queue] ${body.handle} ${body.action} names nothing to change`);
		return 'ack';
	}

	let response: Response;
	try {
		response = await fetch(`${bridge.marqueeUrl}/api/v1/library`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${bridge.marqueeToken}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({ items: [{ type: body.type, id: body.id, ...intent }] })
		});
	} catch {
		return 'retry';
	}

	// A rejected token does not heal by itself: the user has to pair again.
	if (response.status === 401) {
		console.error(`[queue] ${body.handle} Marquee rejected the token; re-pair the bridge`);
		return 'ack';
	}
	if (response.status === 429 || response.status >= 500) return 'retry';

	const result = (await response.json().catch(() => null)) as {
		applied?: number;
		unchanged?: number;
		failed?: { code?: string; reason?: string }[];
	} | null;

	if (!response.ok) {
		console.error(`[queue] ${body.handle} Marquee answered ${response.status}`);
		return 'ack';
	}

	const failure = result?.failed?.[0];
	// The provider being unavailable is a wait, not an answer.
	if (failure?.code === 'upstream_unavailable') return 'retry';
	if (failure) {
		console.warn(`[queue] ${body.handle} ${body.id} dropped: ${failure.code} ${failure.reason}`);
		return 'ack';
	}

	console.log(
		`[queue] ${body.handle} ${body.id} ${body.action}: ${result?.applied ?? 0} applied, ${result?.unchanged ?? 0} unchanged`
	);
	return 'ack';
}

export async function consume(batch: MessageBatch<InboundMessage>, env: Env): Promise<void> {
	for (const message of batch.messages) {
		const outcome = await deliver(env, message.body);

		if (outcome === 'retry' && message.attempts < MAX_DELIVERY_ATTEMPTS) {
			message.retry({ delaySeconds: 30 });
			continue;
		}

		// The give-up decision lives here rather than in the queue's own retry limit, so a message
		// that keeps failing for a reason we can see is logged once instead of cycling quietly.
		if (outcome === 'retry')
			console.error(
				`[queue] ${message.body.handle} ${message.body.id} giving up after ${message.attempts} attempts`
			);

		message.ack();
	}
}
