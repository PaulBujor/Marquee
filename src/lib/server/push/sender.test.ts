import { afterEach, describe, expect, it, vi } from 'vitest';

// Stub the crypto/encryption library — its VAPID + aes128gcm correctness is its own concern; here
// we only verify the sender wires the request to `fetch` and maps the response status.
vi.mock('@pushforge/builder', () => ({
	buildPushHTTPRequest: vi.fn(async () => ({
		endpoint: 'https://push.example/ep',
		headers: { 'content-type': 'application/octet-stream' },
		body: new ArrayBuffer(8)
	}))
}));

import { buildPushHTTPRequest } from '@pushforge/builder';
import { PushForgeSender } from './sender';

const TARGET = {
	endpoint: 'https://push.example/ep',
	keys: { p256dh: 'p256', auth: 'authsecret' }
};
const PAYLOAD = { title: 'New episode', body: 'S2E1 is out', url: '/title/show/42' };

function stubFetch(status: number) {
	const spy = vi.fn(async () => new Response(null, { status }));
	vi.stubGlobal('fetch', spy);
	return spy;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe('PushForgeSender', () => {
	it('builds a signed request from the subscription + payload and POSTs it to the endpoint', async () => {
		const fetchSpy = stubFetch(201);
		const sender = new PushForgeSender('{"kty":"EC"}', 'mailto:a@b.c');

		const res = await sender.send(TARGET, PAYLOAD);

		expect(buildPushHTTPRequest).toHaveBeenCalledWith({
			privateJWK: '{"kty":"EC"}',
			subscription: TARGET,
			message: { payload: PAYLOAD, adminContact: 'mailto:a@b.c' }
		});
		expect(fetchSpy).toHaveBeenCalledWith(
			'https://push.example/ep',
			expect.objectContaining({ method: 'POST' })
		);
		expect(res).toEqual({ ok: true, status: 201, gone: false });
	});

	it('flags 404 and 410 as gone so the caller can prune the subscription', async () => {
		const sender = new PushForgeSender('{}', 'mailto:a@b.c');

		stubFetch(410);
		expect(await sender.send(TARGET, PAYLOAD)).toEqual({ ok: false, status: 410, gone: true });

		stubFetch(404);
		expect((await sender.send(TARGET, PAYLOAD)).gone).toBe(true);
	});

	it('reports other failures without flagging them for prune', async () => {
		stubFetch(429);
		const sender = new PushForgeSender('{}', 'mailto:a@b.c');
		expect(await sender.send(TARGET, PAYLOAD)).toEqual({ ok: false, status: 429, gone: false });
	});
});
