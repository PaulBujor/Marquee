/**
 * The inbound write path: a Stremio action becomes one call to Marquee's library API.
 *
 * The addon route only enqueues, so the reply Stremio waits for never depends on Marquee or on
 * TMDB. Delivery is at-least-once, which is safe because the API takes an *intent* and replaying
 * the same one emits nothing the second time.
 */
import { type AddonAction, type MediaType, isAddonAction, isImdbId } from './addon';
import { type BridgeRecord, isHandle, readBridge, shortHandle, writeBridge } from './bridges';
import { type EpisodeIntent, type Intent, toIntent } from './intent';

/** One parsed Stremio action, on its way to Marquee. */
export interface InboundMessage {
	handle: string;
	/**
	 * The pairing that produced the event. A message outlives its pairing, and re-resolving the
	 * credential at delivery time would otherwise apply one account's action to another's library
	 * after a handle is unpaired and paired again.
	 */
	pairedAt: string;
	type: MediaType;
	id: string;
	action: AddonAction;
	videoIds: string[];
	/** ISO timestamp of the request, so a message stuck in the queue is identifiable. */
	receivedAt: string;
}

/** Past this many deliveries the message is dropped rather than retried forever. */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** apps/web's per-command episode ceiling (`COMMAND_EPISODES_MAX`); a longer mark is chunked. */
const EPISODES_PER_REQUEST = 500;

const REQUEST_TIMEOUT_MS = 10_000;

export type Outcome = 'ack' | 'retry';

/** What one request to Marquee means for the message that caused it. */
type Delivery = 'ok' | 'retry' | 'permanent' | 'unauthenticated';

interface BatchResult {
	applied?: number;
	unchanged?: number;
	failed?: { code?: string; reason?: string }[];
}

/**
 * Applies one message. `retry` is reserved for failures that can resolve themselves: a rate limit,
 * an upstream outage, a network error. Anything else — a dead token, an id nobody can resolve, a
 * request Marquee refuses — is `ack`, because a retry would only repeat the same answer.
 */
export async function deliver(env: Env, body: InboundMessage | null | undefined): Promise<Outcome> {
	// The queue is a trust boundary. The route validates before enqueueing, but a body arrives
	// typed rather than checked, and a second producer will not inherit that discipline.
	if (
		!body ||
		typeof body.handle !== 'string' ||
		!isHandle(body.handle) ||
		!isImdbId(body.id) ||
		!isAddonAction(body.action) ||
		// Checked here so a malformed list is a dropped message rather than a throw inside toIntent.
		!Array.isArray(body.videoIds)
	) {
		console.warn('[queue] malformed message, dropping');
		return 'ack';
	}

	const handle = shortHandle(body.handle);
	const bridge = await readBridge(env.BRIDGES, body.handle);
	// Unpaired or rotated away: there is no longer anyone to write for, and no one to tell.
	if (!bridge) {
		console.log(`[queue] ${handle} is not paired, dropping`);
		return 'ack';
	}

	if (body.pairedAt !== bridge.createdAt) {
		console.warn(`[queue] ${handle} ${body.id} came from an earlier pairing, dropping`);
		return 'ack';
	}

	const intent = toIntent(body);
	if (!intent) {
		console.warn(`[queue] ${handle} ${body.id} ${body.action} names nothing to change`);
		return 'ack';
	}

	let applied = 0;
	let refused = 0;
	for (const part of chunk(intent)) {
		const delivery = await post(bridge, body, part);

		if (delivery === 'retry') return 'retry';
		if (delivery === 'unauthenticated') {
			await markAuthFailed(env, body.handle, bridge);
			console.error(`[queue] ${handle} Marquee rejected the token; only a new bridge recovers`);
			return 'ack';
		}
		// The chunks are independent: one refusal is no reason to abandon the rest, and the count
		// is what makes a partial application visible instead of looking like a clean success.
		if (delivery === 'permanent') {
			refused += 1;
			continue;
		}

		applied += 1;
	}

	// Back in business: a bridge that is working must not keep advertising an old rejection.
	if (bridge.authFailedAt) await clearAuthFailed(env, body.handle, bridge);

	console.log(
		`[queue] ${handle} ${body.id} ${body.action}: ${applied} request(s) applied${
			refused > 0 ? `, ${refused} refused` : ''
		}`
	);
	return 'ack';
}

/**
 * One request per 500 episodes. The API rejects an oversized command outright, and a rejection is
 * permanent here — so a series-wide mark would otherwise be dropped in full, silently.
 */
function chunk(intent: Intent): Intent[] {
	const episodes: EpisodeIntent[] = intent.episodes ?? [];
	if (episodes.length <= EPISODES_PER_REQUEST) return [intent];

	const parts: Intent[] = [];
	for (let index = 0; index < episodes.length; index += EPISODES_PER_REQUEST)
		parts.push({ ...intent, episodes: episodes.slice(index, index + EPISODES_PER_REQUEST) });

	return parts;
}

async function post(bridge: BridgeRecord, body: InboundMessage, intent: Intent): Promise<Delivery> {
	let response: Response;
	try {
		response = await fetch(`${bridge.marqueeUrl}/api/v1/library`, {
			method: 'POST',
			// A redirect would carry the bearer wherever it points, and a hung upstream would stall
			// the whole batch until the platform kills it and redelivers every sibling.
			redirect: 'manual',
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			headers: {
				authorization: `Bearer ${bridge.marqueeToken}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({ items: [{ type: body.type, id: body.id, ...intent }] })
		});
	} catch (error) {
		console.warn(
			`[queue] ${shortHandle(body.handle)} ${body.id} could not reach Marquee (${
				error instanceof Error ? error.name : 'unknown error'
			})`
		);
		return 'retry';
	}

	// Neither a revoked token nor a wrong host heals by itself: the user has to pair again.
	if (response.status === 401 || response.status === 403) return 'unauthenticated';
	if (response.status === 429 || response.status >= 500) return 'retry';

	const result = (await response.json().catch(() => null)) as BatchResult | null;
	if (!response.ok) {
		console.error(
			`[queue] ${shortHandle(body.handle)} ${body.id} Marquee answered ${response.status}`
		);
		return 'permanent';
	}

	const failure = result?.failed?.[0];
	// The provider being unavailable is a wait, not an answer.
	if (failure?.code === 'upstream_unavailable') return 'retry';
	if (failure) {
		console.warn(
			`[queue] ${shortHandle(body.handle)} ${body.id} dropped: ${failure.code} ${failure.reason}`
		);
		return 'permanent';
	}

	return 'ok';
}

async function markAuthFailed(env: Env, handle: string, bridge: BridgeRecord): Promise<void> {
	if (bridge.authFailedAt) return;
	// Re-read: a record written from a stale snapshot would restore the credentials a concurrent
	// re-pair has already replaced, which is the premise of the cross-account bug this check exists for.
	const fresh = await readBridge(env.BRIDGES, handle);
	if (fresh?.createdAt !== bridge.createdAt) return;

	await writeBridge(env.BRIDGES, handle, { ...fresh, authFailedAt: new Date().toISOString() });
}

async function clearAuthFailed(env: Env, handle: string, bridge: BridgeRecord): Promise<void> {
	const fresh = await readBridge(env.BRIDGES, handle);
	if (fresh?.createdAt !== bridge.createdAt) return;

	const cleared = { ...fresh };
	delete cleared.authFailedAt;
	await writeBridge(env.BRIDGES, handle, cleared);
}

export async function consume(batch: MessageBatch<InboundMessage>, env: Env): Promise<void> {
	for (const message of batch.messages) {
		// Labels are computed defensively and inside the guard: a body that is not even the right
		// shape must not be able to throw here and take the whole batch down with it.
		let handle = 'unknown';
		let id = '?';

		let outcome: Outcome;
		try {
			const body: unknown = message.body;
			const named = body as { handle?: unknown; id?: unknown } | null;
			if (typeof named?.handle === 'string') handle = shortHandle(named.handle);
			if (typeof named?.id === 'string') id = named.id;

			outcome = await deliver(env, message.body);
		} catch (error) {
			// One message's unexpected failure must not fail its siblings: they would all be
			// redelivered and every attempt count inflated toward the transport's own limit.
			console.error(
				`[queue] ${handle} ${id} delivery threw (${error instanceof Error ? error.name : 'unknown error'})`
			);
			outcome = 'retry';
		}

		if (outcome === 'retry' && message.attempts < MAX_DELIVERY_ATTEMPTS) {
			// Linear backoff, so a burst that failed together does not redeliver in lockstep.
			// shortcut: a retried message lands after later actions on the same title and wins on
			// the clock; per-handle sequencing is the reconcile's Durable Object.
			message.retry({ delaySeconds: 30 * message.attempts });
			continue;
		}

		// The give-up decision lives here rather than in the queue's own retry limit, so a message
		// that keeps failing for a reason we can see is logged once instead of cycling quietly.
		if (outcome === 'retry')
			console.error(
				`[queue] ${handle} ${id} giving up after ${message.attempts} attempts (received ${
					typeof message.body?.receivedAt === 'string' ? message.body.receivedAt : '?'
				})`
			);

		message.ack();
	}
}
