import { afterEach, describe, expect, it, vi } from 'vitest';
import { newHandle, readBridge, writeBridge, type BridgeRecord } from './bridges';
import worker from './index';
import { memoryKv } from './testing/kv';
import { stremioAccountApi } from './testing/stremio';

// The generated `Env` pins the deployed URLs as literal types, so the tests use them as-is:
// anything else would need a cast, and these literals are what the deploy actually configures.
const MARQUEE = 'https://marquee.paulbujor.net';
const STREMIO = 'https://api.strem.io/api';
const STREMIO_ORIGIN = new URL(STREMIO).origin;
const TOKEN = 'mqr_test_token';
const AUTH_KEY = 'stremio-test-auth-key';

const record = (overrides: Partial<BridgeRecord> = {}): BridgeRecord => ({
	marqueeToken: TOKEN,
	stremioAuthKey: AUTH_KEY,
	marqueeUrl: MARQUEE,
	createdAt: new Date(0).toISOString(),
	...overrides
});

const env = (BRIDGES = memoryKv()): Env => ({
	BRIDGES,
	MARQUEE_API_URL: MARQUEE,
	STREMIO_API_URL: STREMIO
});

const call = (path: string, init?: RequestInit, bindings = env()) =>
	worker.fetch(new Request(`https://bridge.test${path}`, init), bindings);

const form = (fields: Record<string, string>) => {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return { method: 'POST', body };
};

/** A handle whose KV record already exists, as if pairing had run. */
async function paired(): Promise<{ handle: string; bindings: Env }> {
	const bindings = env();
	const handle = newHandle();
	await writeBridge(bindings.BRIDGES, handle, record());
	return { handle, bindings };
}

/**
 * Routes the two services the bridge calls — Marquee's read model and Stremio's account API —
 * and throws on anything else, so a new outbound call can never pass unnoticed.
 */
function stubServices(options: { token?: string; authKey?: string } = {}) {
	const account = stremioAccountApi({ authKey: options.authKey ?? AUTH_KEY });

	const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		// Compare the origin exactly rather than as a prefix: a stub that accepted
		// `https://marquee.paulbujor.net.evil` would hide a real misroute.
		const { origin } = new URL(url);

		if (origin === MARQUEE) {
			const auth = new Headers(init?.headers).get('authorization');
			// The shape matters: a 200 that is not this envelope must not read as a valid token.
			return auth === `Bearer ${options.token ?? TOKEN}`
				? Response.json({ entries: [], nextCursor: null })
				: Response.json({ title: 'Unauthorized' }, { status: 401 });
		}

		if (origin === STREMIO_ORIGIN) return account.fetch(url, init);

		throw new Error(`unexpected fetch: ${url}`);
	});

	vi.stubGlobal('fetch', fetch);
	return { account, fetch };
}

afterEach(() => vi.unstubAllGlobals());

describe('routing', () => {
	it('answers the readiness probe without touching a handle', async () => {
		const res = await call('/healthz');

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'ok' });
	});

	// A bridge with a dead binding must not report healthy — the point of the probe.
	it('reports unavailable when the KV binding is broken', async () => {
		// SAFETY: health calls only `get`; the other KVNamespace members are never reached.
		const broken = {
			get: async () => Promise.reject(new Error('BRIDGES down'))
		} as unknown as KVNamespace;

		const res = await call('/healthz', undefined, env(broken));

		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ status: 'unavailable' });
	});

	it('mints a handle for a fresh pairing', async () => {
		for (const path of ['/', '/configure']) {
			const res = await call(path);

			expect(res.status).toBe(302);
			expect(res.headers.get('location')).toMatch(/^\/configure\/sbr_[A-Za-z0-9_-]{43}$/);
		}
	});

	// The handle is the only credential on the addon surface, so an unknown one must be
	// indistinguishable from any other unknown path — no echoing, no hint that it was close.
	it('404s an unknown handle without echoing it', async () => {
		const res = await call('/sbr_unknown/manifest.json');

		expect(res.status).toBe(404);
		expect(await res.text()).not.toContain('sbr_unknown');
	});

	// The format check runs before KV: a key we could never have minted must not become a lookup.
	it('rejects a mintable-shaped-but-unknown key before it reaches KV', async () => {
		const bindings = env(memoryKv({ 'handle:abc123': JSON.stringify(record()) }));

		expect((await call('/abc123/manifest.json', undefined, bindings)).status).toBe(404);
	});

	it('404s the paths that are not routes', async () => {
		const { handle, bindings } = await paired();

		for (const path of [
			'/sbr_short/manifest.json',
			'/configure/nope',
			`/configure/${handle}/extra`,
			`/${handle}`,
			`/${handle}/library`,
			`/${handle}/manifest.json/extra`
		]) {
			expect((await call(path, undefined, bindings)).status).toBe(404);
		}
	});

	it('answers CORS preflight', async () => {
		const res = await call('/sbr_unknown/manifest.json', { method: 'OPTIONS' });

		expect(res.status).toBe(204);
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
	});

	// 405 must say what is allowed, and nil-method routes must not fall through to a handler.
	it('answers 405 with an Allow header', async () => {
		const { handle, bindings } = await paired();

		const onConfigure = await call(`/configure/${handle}`, { method: 'PUT' }, bindings);
		expect(onConfigure.status).toBe(405);
		expect(onConfigure.headers.get('allow')).toBe('GET, POST, OPTIONS');

		const onLibrary = await call(
			`/${handle}/library/movie/tt0133093/action=watched.json`,
			{ method: 'DELETE' },
			bindings
		);
		expect(onLibrary.status).toBe(405);
		expect(onLibrary.headers.get('allow')).toBe('GET, OPTIONS');
	});
});

describe('manifest', () => {
	it('serves the paired handle with CORS, cacheable but private', async () => {
		const { handle, bindings } = await paired();
		const res = await call(`/${handle}/manifest.json`, undefined, bindings);

		expect(res.status).toBe(200);
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
		// Private: the id embeds the handle, so no shared cache may keep it.
		expect(res.headers.get('cache-control')).toBe('private, max-age=300');
		expect(await res.json()).toMatchObject({
			id: `org.marquee.bridge.${handle}`,
			version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
			resources: ['library'],
			types: ['movie', 'series'],
			idPrefixes: ['tt'],
			catalogs: []
		});
	});

	it('404s before pairing, so an unfinished bridge cannot be installed', async () => {
		expect((await call(`/${newHandle()}/manifest.json`)).status).toBe(404);
	});
});

describe('pairing', () => {
	it('renders the form for a fresh handle', async () => {
		const res = await call(`/configure/${newHandle()}`);

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/html');
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.get('referrer-policy')).toBe('no-referrer');
		expect(res.headers.get('x-frame-options')).toBe('DENY');
		expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");

		const html = await res.text();
		expect(html).toContain('name="marqueeToken"');
		expect(html).toContain('name="stremioAuthKey"');
	});

	it('stores both credentials and shows the install URL', async () => {
		const { account, fetch } = stubServices();
		const handle = newHandle();
		const bindings = env();

		const res = await call(
			`/configure/${handle}`,
			form({ marqueeToken: TOKEN, stremioAuthKey: AUTH_KEY }),
			bindings
		);

		expect(res.status).toBe(200);
		expect(await res.text()).toContain(`stremio://bridge.test/${handle}/manifest.json`);
		expect(await readBridge(bindings.BRIDGES, handle)).toMatchObject({
			marqueeToken: TOKEN,
			stremioAuthKey: AUTH_KEY,
			marqueeUrl: MARQUEE
		});

		// One read of Marquee's library and one Stremio metadata call, nothing more.
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls[0][0]).toBe(`${MARQUEE}/api/v1/library?limit=1`);
		expect(fetch.mock.calls[1][0]).toBe(`${STREMIO}/datastoreMeta`);

		// The body is a contract: the double would answer any collection name, so a typo here
		// would pass every other test and break every real pairing.
		expect(account.requests).toEqual([
			{ url: `${STREMIO}/datastoreMeta`, body: { authKey: AUTH_KEY, collection: 'libraryItem' } }
		]);
	});

	it('rejects a token Marquee does not accept, and stores nothing', async () => {
		const { fetch } = stubServices();
		const handle = newHandle();
		const bindings = env();

		const res = await call(
			`/configure/${handle}`,
			form({ marqueeToken: 'not-a-token', stremioAuthKey: AUTH_KEY }),
			bindings
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toContain('Marquee did not accept that token');
		expect(await readBridge(bindings.BRIDGES, handle)).toBeNull();

		// A bad token is answered before Stremio is called at all.
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('refuses a 200 that is not Marquee\u2019s read model', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ items: [], nextCursor: null }))
		);
		const bindings = env();
		const handle = newHandle();

		const res = await call(
			`/configure/${handle}`,
			form({ marqueeToken: TOKEN, stremioAuthKey: AUTH_KEY }),
			bindings
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toContain('shape we do not recognise');
		expect(await readBridge(bindings.BRIDGES, handle)).toBeNull();
	});

	it('surfaces the reason Stremio gives for a bad auth key', async () => {
		stubServices({ authKey: 'somebody-elses-key' });
		const handle = newHandle();
		const bindings = env();

		const res = await call(
			`/configure/${handle}`,
			form({ marqueeToken: TOKEN, stremioAuthKey: 'wrong' }),
			bindings
		);

		expect(res.status).toBe(400);
		const html = await res.text();
		expect(html).toContain('sync disabled');
		expect(html).toContain('data-field="stremioAuthKey"');
		expect(await readBridge(bindings.BRIDGES, handle)).toBeNull();
	});

	it('requires each value without calling anything', async () => {
		const { fetch } = stubServices();
		const handle = newHandle();

		const noToken = await call(`/configure/${handle}`, form({ stremioAuthKey: AUTH_KEY }));
		expect(noToken.status).toBe(400);
		const noTokenHtml = await noToken.text();
		expect(noTokenHtml).toContain('Marquee token is required');
		expect(noTokenHtml).toContain('data-field="marqueeToken"');

		const noKey = await call(`/configure/${handle}`, form({ marqueeToken: TOKEN }));
		expect(noKey.status).toBe(400);
		expect(await noKey.text()).toContain('Stremio auth key is required');

		expect(fetch).not.toHaveBeenCalled();
	});

	// A handle is a capability to use a bridge, not to take it over: learning the URL must not
	// be enough to repoint someone's Stremio events into another account.
	it('refuses to repoint a paired bridge with a different token', async () => {
		stubServices({ token: 'attacker-token' });
		const { handle, bindings } = await paired();

		const res = await call(
			`/configure/${handle}`,
			form({ marqueeToken: 'attacker-token', stremioAuthKey: 'attacker-key' }),
			bindings
		);

		expect(res.status).toBe(409);
		expect(await res.text()).toContain('already paired');
		expect(await readBridge(bindings.BRIDGES, handle)).toEqual(record());
	});

	it('lets the holder of the token rotate the Stremio key', async () => {
		stubServices({ authKey: 'rotated-key' });
		const { handle, bindings } = await paired();

		const res = await call(
			`/configure/${handle}`,
			form({ marqueeToken: TOKEN, stremioAuthKey: 'rotated-key' }),
			bindings
		);

		expect(res.status).toBe(200);
		expect(await readBridge(bindings.BRIDGES, handle)).toMatchObject({
			marqueeToken: TOKEN,
			stremioAuthKey: 'rotated-key'
		});
	});

	it('disconnects only for the holder of the token, and forgets the credentials', async () => {
		const { handle, bindings } = await paired();

		const refused = await call(
			`/configure/${handle}`,
			form({ marqueeToken: 'not-the-token', action: 'unpair' }),
			bindings
		);
		expect(refused.status).toBe(409);
		expect(await readBridge(bindings.BRIDGES, handle)).not.toBeNull();

		const ok = await call(
			`/configure/${handle}`,
			form({ marqueeToken: TOKEN, action: 'unpair' }),
			bindings
		);
		expect(ok.status).toBe(200);
		expect(await readBridge(bindings.BRIDGES, handle)).toBeNull();
		expect((await call(`/${handle}/manifest.json`, undefined, bindings)).status).toBe(404);
	});

	it('shows a paired handle its paired state rather than a fresh form', async () => {
		const { handle, bindings } = await paired();

		const html = await (await call(`/configure/${handle}`, undefined, bindings)).text();

		expect(html).toContain('already paired');
		expect(html).toContain('value="unpair"');
	});
});

describe('library events', () => {
	const log = () => vi.spyOn(console, 'log').mockImplementation(() => {});

	it('acknowledges a watched movie', async () => {
		const spy = log();
		const { handle, bindings } = await paired();

		const res = await call(
			`/${handle}/library/movie/tt0133093/action=watched.json`,
			undefined,
			bindings
		);

		expect(res.status).toBe(200);
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.json()).toEqual({ success: true });
		expect(spy).toHaveBeenCalledWith(
			`[event] ${handle} {"type":"movie","id":"tt0133093","action":"watched","videoIds":[]}`
		);
	});

	// The whole list arrives in one event, so a season mark must decode as one intent.
	it('decodes a season of episodes from one event', async () => {
		const spy = log();
		const { handle, bindings } = await paired();

		const res = await call(
			`/${handle}/library/series/tt0944947/action=watched&videoId=tt0944947%3A1%3A1%2Ctt0944947%3A1%3A2.json`,
			undefined,
			bindings
		);

		expect(await res.json()).toEqual({ success: true });
		expect(spy).toHaveBeenCalledWith(
			`[event] ${handle} {"type":"show","id":"tt0944947","action":"watched","videoIds":["tt0944947:1:1","tt0944947:1:2"]}`
		);
	});

	// The protocol allows the extra props in the query string too. Acknowledging an event we
	// never looked at is worse than rejecting it: the client does not retry.
	it('reads the extra props from the query string as well', async () => {
		const spy = log();
		const { handle, bindings } = await paired();

		const res = await call(
			`/${handle}/library/series/tt0944947.json?action=unwatched&videoId=tt0944947%3A2%3A5`,
			undefined,
			bindings
		);

		expect(await res.json()).toEqual({ success: true });
		expect(spy).toHaveBeenCalledWith(
			`[event] ${handle} {"type":"show","id":"tt0944947","action":"unwatched","videoIds":["tt0944947:2:5"]}`
		);
	});

	// A videoId naming another title would land an episode watch on the wrong show.
	it('drops a videoId that does not belong to the event\u2019s id', async () => {
		const spy = log();
		const { handle, bindings } = await paired();

		await call(
			`/${handle}/library/series/tt0944947/action=watched&videoId=tt0133093%3A1%3A1.json`,
			undefined,
			bindings
		);

		expect(spy).toHaveBeenCalledWith(
			`[event] ${handle} {"type":"show","id":"tt0944947","action":"watched","videoIds":[]}`
		);
	});

	// Stremio ignores the reply and never retries, so a deliberate drop still says success —
	// answering anything else would only make the client retry what we chose to ignore.
	it('acknowledges an event it deliberately drops', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { handle, bindings } = await paired();

		for (const path of [
			`/${handle}/library/channel/tt1/action=libraryAdd.json`,
			`/${handle}/library/movie/tt1/action=played.json`,
			`/${handle}/library/movie/tt1.json`
		]) {
			const res = await call(path, undefined, bindings);

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ success: true });
		}

		expect(warn).toHaveBeenCalledWith(`[event] ${handle} ignored type:channel`);
		expect(warn).toHaveBeenCalledWith(`[event] ${handle} ignored action:played`);
	});

	it('404s a malformed event rather than acknowledging it', async () => {
		const { handle, bindings } = await paired();

		for (const path of [
			`/${handle}/library/movie/tt1/action=watched&videoId=tt%`,
			`/${handle}/library/movie/tt1/action=watched&videoId=tt1.jsonx`,
			`/${handle}/library/movie/yt:abc/action=watched.json`,
			`/${handle}/library/movie`,
			`/${handle}/library/movie/tt1/action=watched/videoId=tt1%3A1%3A1.json`
		]) {
			expect((await call(path, undefined, bindings)).status).toBe(404);
		}
	});

	it('404s an event for an unknown handle', async () => {
		const res = await call(`/${newHandle()}/library/movie/tt1/action=watched.json`);

		expect(res.status).toBe(404);
	});
});
