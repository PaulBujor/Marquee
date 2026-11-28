import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newHandle, readBridge, writeBridge, type BridgeRecord } from './bridges';
import { MAX_DELIVERY_ATTEMPTS, consume, deliver } from './queue';
import { memoryKv } from './testing/kv';
import {
	PAIRED_AT,
	VALID_HANDLE,
	fakeQueue,
	inboundBatch,
	inboundBody,
	inboundMessage
} from './testing/queue';

const MARQUEE = 'https://marquee.paulbujor.net';
const STREMIO = 'https://api.strem.io/api';
/** Deliberately NOT the env URL: the record's own url is what the consumer must use. */
const PAIRED_URL = 'https://marquee.example';
const TOKEN = 'mqr_test_token';

const record = (overrides: Partial<BridgeRecord> = {}): BridgeRecord => ({
	marqueeToken: TOKEN,
	stremioAuthKey: 'stremio-key',
	marqueeUrl: PAIRED_URL,
	createdAt: PAIRED_AT,
	...overrides
});

const env = (BRIDGES = memoryKv()): Env => ({
	BRIDGES,
	INBOUND: fakeQueue().binding,
	MARQUEE_API_URL: MARQUEE,
	STREMIO_API_URL: STREMIO
});

async function paired(overrides: Partial<BridgeRecord> = {}) {
	const bindings = env();
	const handle = newHandle();
	await writeBridge(bindings.BRIDGES, handle, record(overrides));
	return { handle, bindings };
}

interface Call {
	url: string;
	init?: RequestInit;
}

/** Marquee answers `body` at `status`, recording every call so the request is assertable. */
function marqueeAnswers(status = 200, body: unknown = { applied: 1, unchanged: 0, failed: [] }) {
	const calls: Call[] = [];

	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			return Response.json(body, { status });
		})
	);

	return calls;
}

const items = (call: Call) => JSON.parse(String(call.init?.body)).items;

beforeEach(() => {
	for (const method of ['log', 'warn', 'error'] as const)
		vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('deliver', () => {
	it("posts the intent with the record's own credentials and url", async () => {
		const calls = marqueeAnswers();
		const { handle, bindings } = await paired();

		const outcome = await deliver(
			bindings,
			inboundBody({
				handle,
				type: 'show',
				id: 'tt0944947',
				action: 'watched',
				videoIds: ['tt0944947:1:1', 'tt0944947:1:2']
			})
		);

		expect(outcome).toBe('ack');
		expect(calls).toHaveLength(1);

		const [call] = calls;
		// The record's url, not `env.MARQUEE_API_URL` — the two are different on purpose here.
		expect(call.url).toBe(`${PAIRED_URL}/api/v1/library`);
		expect(call.init?.method).toBe('POST');
		// A redirect would carry the bearer wherever it pointed.
		expect(call.init?.redirect).toBe('manual');
		expect(call.init?.signal).toBeDefined();
		expect(new Headers(call.init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
		expect(items(call)).toEqual([
			{
				type: 'show',
				id: 'tt0944947',
				episodes: [
					{ season: 1, episode: 1, watched: true },
					{ season: 1, episode: 2, watched: true }
				]
			}
		]);
	});

	// Every intent must carry at least one command field: the API rejects an item that names
	// only `type` and `id`, so an empty intent would be a 400 that we would then ack.
	it('always sends a command field', async () => {
		const calls = marqueeAnswers();
		const { handle, bindings } = await paired();

		await deliver(bindings, inboundBody({ handle }));

		expect(Object.keys(items(calls[0])[0]).sort()).toEqual(['id', 'status', 'type']);
	});

	it('drops a message whose bridge is gone before calling anything', async () => {
		const calls = marqueeAnswers();

		expect(await deliver(env(), inboundBody({ handle: newHandle() }))).toBe('ack');
		expect(calls).toHaveLength(0);
	});

	// A message outlives its pairing: if the handle was unpaired and paired again since, this
	// intent belongs to an account that is no longer behind it.
	it('drops a message produced by an earlier pairing', async () => {
		const calls = marqueeAnswers();
		const { handle, bindings } = await paired();

		const outcome = await deliver(bindings, inboundBody({ handle, pairedAt: 'older' }));

		expect(outcome).toBe('ack');
		expect(calls).toHaveLength(0);
		expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('earlier pairing'));
	});

	// The trust boundary the guard defends: a second producer sending a shape the route would
	// never produce. Paired first, so the guard is the only thing that can stop the request.
	it('drops a malformed message even when its handle is paired', async () => {
		const calls = marqueeAnswers();
		const { handle, bindings } = await paired();

		for (const body of [
			inboundBody({ handle, id: 'yt:abc' }),
			inboundBody({ handle, action: 'played' as never }),
			inboundBody({ handle, videoIds: 'tt1:1:1' as never }),
			{ ...inboundBody({ handle }), handle: 123 as never },
			null,
			undefined
		]) {
			expect(await deliver(bindings, body)).toBe('ack');
		}

		expect(calls).toHaveLength(0);
	});

	// Nothing to say is not a failure: acked, and no request is made on its behalf.
	// A bare gesture on a show is a whole-title claim now, so "names nothing" means the videoIds
	// were present but named no episode of this title.
	it('drops a message that names nothing to change before calling anything', async () => {
		const calls = marqueeAnswers();
		const { handle, bindings } = await paired();

		const outcome = await deliver(
			bindings,
			inboundBody({ handle, type: 'show', action: 'watched', videoIds: ['tt2:1:1'] })
		);

		expect(outcome).toBe('ack');
		expect(calls).toHaveLength(0);
	});

	// The bare watch really does reach the API, as one field rather than an enumerated list.
	it('sends a bare watch as a whole-title intent', async () => {
		const calls = marqueeAnswers();
		const { handle, bindings } = await paired();

		await deliver(bindings, inboundBody({ handle, type: 'show', action: 'watched', videoIds: [] }));

		expect(calls).toHaveLength(1);
		expect(JSON.parse(String(calls[0].init?.body)).items).toEqual([
			{ type: 'show', id: 'tt0133093', allEpisodes: { watched: true } }
		]);
	});

	// The destructive direction is the one an unauthenticated URL must not be able to fire.
	it('acknowledges a bare un-watch without touching the library', async () => {
		const calls = marqueeAnswers();
		const { handle, bindings } = await paired();

		const outcome = await deliver(
			bindings,
			inboundBody({ handle, type: 'show', action: 'unwatched', videoIds: [] })
		);

		expect(outcome).toBe('ack');
		expect(calls).toHaveLength(0);
	});

	// A dead token does not heal by itself, so the record carries the failure and the configure
	// page can say so — otherwise a user who revokes a leaked token loses sync in silence.
	it('records a rejected token on the bridge, and clears it once a delivery succeeds', async () => {
		marqueeAnswers(401, { title: 'Unauthorized' });
		const { handle, bindings } = await paired();

		expect(await deliver(bindings, inboundBody({ handle }))).toBe('ack');
		const first = (await readBridge(bindings.BRIDGES, handle))?.authFailedAt;
		expect(first).toEqual(expect.any(String));
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('new bridge'));

		// A second rejection must not rewrite the stamp: the first failure is the informative one.
		await deliver(bindings, inboundBody({ handle }));
		expect((await readBridge(bindings.BRIDGES, handle))?.authFailedAt).toBe(first);

		// 403 is the same answer as 401.
		marqueeAnswers(403, { title: 'Forbidden' });
		expect(await deliver(bindings, inboundBody({ handle }))).toBe('ack');

		marqueeAnswers();
		await deliver(bindings, inboundBody({ handle }));

		expect((await readBridge(bindings.BRIDGES, handle))?.authFailedAt).toBeUndefined();
	});

	// A redirect means the configured url is wrong; retrying it would never make it right.
	it('treats a redirect as permanent', async () => {
		marqueeAnswers(301, {});
		const { handle, bindings } = await paired();

		expect(await deliver(bindings, inboundBody({ handle }))).toBe('ack');
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('301'));
	});

	it('retries what can resolve itself', async () => {
		const { handle, bindings } = await paired();

		const transient: [number, unknown][] = [
			[429, { title: 'Too many requests' }],
			[500, { title: 'Server error' }],
			[503, { title: 'Unavailable' }],
			[200, { applied: 0, unchanged: 0, failed: [{ code: 'upstream_unavailable' }] }]
		];

		for (const [status, body] of transient) {
			marqueeAnswers(status, body);
			expect(await deliver(bindings, inboundBody({ handle }))).toBe('retry');
		}
	});

	it('retries a network failure', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('network');
			})
		);
		const { handle, bindings } = await paired();

		expect(await deliver(bindings, inboundBody({ handle }))).toBe('retry');
	});

	// An id nobody can resolve will not resolve on the next delivery either.
	it('gives up on an id Marquee cannot resolve', async () => {
		marqueeAnswers(200, {
			applied: 0,
			unchanged: 0,
			failed: [{ code: 'unresolved', reason: 'no single title' }]
		});
		const { handle, bindings } = await paired();

		expect(await deliver(bindings, inboundBody({ handle }))).toBe('ack');
	});

	it('gives up on a request Marquee refuses', async () => {
		marqueeAnswers(400, { title: 'Malformed request body' });
		const { handle, bindings } = await paired();

		expect(await deliver(bindings, inboundBody({ handle }))).toBe('ack');
	});

	it('treats a body it cannot read as a success, not as a failure to repeat', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('not json', { status: 200 }))
		);
		const { handle, bindings } = await paired();

		expect(await deliver(bindings, inboundBody({ handle }))).toBe('ack');
	});

	// The chunks are independent, so a refusal of one must not discard the rest — and the count
	// has to say so, or a partial mark looks exactly like a complete one.
	it('applies the chunks that succeed when one is refused', async () => {
		const calls: Call[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url, init });
				return calls.length === 2
					? Response.json({ applied: 0, unchanged: 0, failed: [{ code: 'unresolved' }] })
					: Response.json({ applied: 1, unchanged: 0, failed: [] });
			})
		);
		const { handle, bindings } = await paired();
		const videoIds = Array.from({ length: 600 }, (_, index) => `tt1:1:${index + 1}`);

		const outcome = await deliver(
			bindings,
			inboundBody({ handle, type: 'show', id: 'tt1', action: 'watched', videoIds })
		);

		expect(outcome).toBe('ack');
		expect(calls).toHaveLength(2);
		expect(console.log).toHaveBeenCalledWith(
			expect.stringContaining('1 request(s) applied, 1 refused')
		);
	});

	// The API rejects a command with more than 500 episodes outright, and a rejection is permanent
	// here — so a series-wide mark has to be split rather than dropped in full.
	it('splits a mark bigger than the API accepts', async () => {
		const calls = marqueeAnswers();
		const { handle, bindings } = await paired();
		const videoIds = Array.from({ length: 600 }, (_, index) => `tt1:1:${index + 1}`);

		const outcome = await deliver(
			bindings,
			inboundBody({ handle, type: 'show', id: 'tt1', action: 'watched', videoIds })
		);

		expect(outcome).toBe('ack');
		expect(calls).toHaveLength(2);
		expect(items(calls[0])[0].episodes).toHaveLength(500);
		expect(items(calls[1])[0].episodes).toHaveLength(100);
	});
});

describe('consume', () => {
	it('retries a message that has attempts left, with a growing delay', async () => {
		marqueeAnswers(503, {});
		const { handle, bindings } = await paired();

		for (const [attempts, delay] of [
			[2, 60],
			[3, 90]
		] as const) {
			const message = inboundMessage({ handle }, attempts);

			await consume(inboundBatch([message]), bindings);

			expect(message.retried).toBe(true);
			expect(message.acked).toBe(false);
			// Backoff, so a burst that failed together does not redeliver in lockstep.
			expect(message.retryDelaySeconds).toBe(delay);
		}
	});

	// The cap is ours, and it has to stay below the transport's own limit to mean anything.
	it('gives up after five attempts', () => {
		expect(MAX_DELIVERY_ATTEMPTS).toBe(5);
	});

	// The give-up policy is ours: past the cap the message is acknowledged and logged, so a
	// permanently failing title cannot cycle until the transport's own limit fires.
	it('acknowledges a message on its last allowed attempt', async () => {
		marqueeAnswers(503, {});
		const { handle, bindings } = await paired();
		const last = inboundMessage({ handle }, MAX_DELIVERY_ATTEMPTS);

		await consume(inboundBatch([last]), bindings);

		expect(last.acked).toBe(true);
		expect(last.retried).toBe(false);
		// The timestamp is the only handle on a message that has been sitting in the queue.
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining('giving up after 5 attempts (received 1970-01-01T00:00:00.000Z)')
		);

		// One attempt earlier it would still have been retried.
		const remaining = inboundMessage({ handle }, MAX_DELIVERY_ATTEMPTS - 1);
		await consume(inboundBatch([remaining]), bindings);
		expect(remaining.retried).toBe(true);
	});

	it('acknowledges a message that was applied, and keeps draining the batch', async () => {
		marqueeAnswers();
		const { handle, bindings } = await paired();
		const applied = inboundMessage({ handle });
		const gone = inboundMessage({ handle: newHandle() });

		await consume(inboundBatch([applied, gone]), bindings);

		expect(applied.acked).toBe(true);
		expect(gone.acked).toBe(true);
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining('1 request(s) applied'));
	});

	// One message's unexpected failure must not fail its siblings and inflate every attempt count.
	it('isolates a message whose delivery throws', async () => {
		marqueeAnswers();
		let reads = 0;
		// SAFETY: deliver only calls `get`; the first call throws, the rest behave like KV.
		const flaky = {
			get: async () => {
				reads += 1;
				if (reads === 1) throw new Error('kv down');
				return null;
			}
		} as unknown as KVNamespace;
		const bindings = env(flaky);

		const first = inboundMessage({ handle: VALID_HANDLE });
		const second = inboundMessage({ handle: newHandle() });

		await consume(inboundBatch([first, second]), bindings);

		expect(first.retried).toBe(true);
		expect(second.acked).toBe(true);
	});
});
