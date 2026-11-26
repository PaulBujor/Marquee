import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newHandle, writeBridge, type BridgeRecord } from './bridges';
import { MAX_DELIVERY_ATTEMPTS, consume, deliver } from './queue';
import { memoryKv } from './testing/kv';
import { fakeQueue, inboundBatch, inboundBody, inboundMessage } from './testing/queue';

const MARQUEE = 'https://marquee.paulbujor.net';
const STREMIO = 'https://api.strem.io/api';
const TOKEN = 'mqr_test_token';

const record = (): BridgeRecord => ({
	marqueeToken: TOKEN,
	stremioAuthKey: 'stremio-key',
	marqueeUrl: MARQUEE,
	createdAt: new Date(0).toISOString()
});

const env = (BRIDGES = memoryKv()): Env => ({
	BRIDGES,
	INBOUND: fakeQueue().binding,
	MARQUEE_API_URL: MARQUEE,
	STREMIO_API_URL: STREMIO
});

async function paired(): Promise<{ handle: string; bindings: Env }> {
	const bindings = env();
	const handle = newHandle();
	await writeBridge(bindings.BRIDGES, handle, record());
	return { handle, bindings };
}

interface Call {
	url: string;
	init?: RequestInit;
}

/** Answers Marquee with `body` at `status`, recording every call so the request is assertable. */
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

beforeEach(() => {
	for (const method of ['log', 'warn', 'error'] as const)
		vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => vi.unstubAllGlobals());

describe('deliver', () => {
	it('posts the intent to the Marquee the bridge was paired with', async () => {
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
		expect(calls[0].url).toBe(`${MARQUEE}/api/v1/library`);
		expect(new Headers(calls[0].init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			items: [
				{
					type: 'show',
					id: 'tt0944947',
					episodes: [
						{ season: 1, episode: 1, watched: true },
						{ season: 1, episode: 2, watched: true }
					]
				}
			]
		});
	});

	it('drops a message whose bridge is gone before calling anything', async () => {
		const calls = marqueeAnswers();

		const outcome = await deliver(env(), inboundBody({ handle: newHandle() }));

		expect(outcome).toBe('ack');
		expect(calls).toHaveLength(0);
	});

	// Nothing to say is not a failure: acked, and no request is made on its behalf.
	it('drops a message that names nothing to change before calling anything', async () => {
		const calls = marqueeAnswers();
		const { handle, bindings } = await paired();

		const outcome = await deliver(
			bindings,
			inboundBody({ handle, type: 'show', action: 'watched', videoIds: [] })
		);

		expect(outcome).toBe('ack');
		expect(calls).toHaveLength(0);
	});

	// A dead token does not heal by itself, so retrying it would only burn the attempt budget.
	it('gives up on a rejected token instead of retrying it', async () => {
		marqueeAnswers(401, { title: 'Unauthorized' });
		const { handle, bindings } = await paired();

		expect(await deliver(bindings, inboundBody({ handle }))).toBe('ack');
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('re-pair'));
	});

	it('retries what can resolve itself', async () => {
		const { handle, bindings } = await paired();

		const transient: [number, unknown][] = [
			[429, { title: 'Too many requests' }],
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
});

describe('consume', () => {
	it('retries a message that has attempts left', async () => {
		marqueeAnswers(503, {});
		const { handle, bindings } = await paired();
		const message = inboundMessage({ handle }, 1);

		await consume(inboundBatch([message]), bindings);

		expect(message.retried).toBe(true);
		expect(message.acked).toBe(false);
	});

	// The give-up policy is ours: past the cap the message is acknowledged and logged, so a
	// permanently failing title cannot cycle until the transport's own limit fires.
	it('acknowledges a message on its last allowed attempt', async () => {
		marqueeAnswers(503, {});
		const { handle, bindings } = await paired();
		const message = inboundMessage({ handle }, MAX_DELIVERY_ATTEMPTS);

		await consume(inboundBatch([message]), bindings);

		expect(message.acked).toBe(true);
		expect(message.retried).toBe(false);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('giving up'));
	});

	it('acknowledges a message that was applied, and keeps draining the batch', async () => {
		marqueeAnswers();
		const { handle, bindings } = await paired();
		const applied = inboundMessage({ handle });
		const gone = inboundMessage({ handle: newHandle() });

		await consume(inboundBatch([applied, gone]), bindings);

		expect(applied.acked).toBe(true);
		expect(gone.acked).toBe(true);
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining('1 applied'));
	});
});
