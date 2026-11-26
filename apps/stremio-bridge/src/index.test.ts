import { afterEach, describe, expect, it, vi } from 'vitest';
import { newHandle, readBridge, writeBridge, type BridgeRecord } from './bridges';
import worker from './index';
import { memoryKv } from './testing/kv';
import { stremioAccountApi } from './testing/stremio';

// The generated `Env` pins the deployed URLs as literal types, so the tests use them as-is:
// anything else would need a cast, and these literals are what the deploy actually configures.
const MARQUEE = 'https://marquee.paulbujor.net';
const STREMIO = 'https://api.strem.io/api';
const TOKEN = 'mqr_test_token';
const AUTH_KEY = 'stremio-test-auth-key';

const record = (): BridgeRecord => ({
	marqueeToken: TOKEN,
	stremioAuthKey: AUTH_KEY,
	createdAt: new Date(0).toISOString()
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

		if (url.startsWith(MARQUEE)) {
			const auth = new Headers(init?.headers).get('authorization');
			return auth === `Bearer ${options.token ?? TOKEN}`
				? Response.json({ items: [], nextCursor: null })
				: Response.json({ title: 'Unauthorized' }, { status: 401 });
		}

		if (url.startsWith(STREMIO)) return account.fetch(url, init);

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

	it('404s a handle it could not have minted', async () => {
		for (const path of ['/abc123/manifest.json', '/sbr_short/manifest.json', '/configure/nope']) {
			expect((await call(path)).status).toBe(404);
		}
	});

	it('answers CORS preflight', async () => {
		const res = await call('/sbr_unknown/manifest.json', { method: 'OPTIONS' });

		expect(res.status).toBe(204);
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
	});
});

describe('manifest', () => {
	it('serves the paired handle with CORS', async () => {
		const { handle, bindings } = await paired();
		const res = await call(`/${handle}/manifest.json`, undefined, bindings);

		expect(res.status).toBe(200);
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
		expect(await res.json()).toMatchObject({
			id: `org.marquee.bridge.${handle}`,
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

		const html = await res.text();
		expect(html).toContain('name="marqueeToken"');
		expect(html).toContain('name="stremioAuthKey"');
	});

	it('stores both credentials and shows the install URL', async () => {
		const { fetch } = stubServices();
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
			stremioAuthKey: AUTH_KEY
		});

		// One read of Marquee's library and one Stremio metadata call, nothing more.
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls[0][0]).toBe(`${MARQUEE}/api/v1/library?limit=1`);
		expect(fetch.mock.calls[1][0]).toBe(`${STREMIO}/datastoreMeta`);
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
		expect(await res.text()).toContain('sync disabled');
		expect(await readBridge(bindings.BRIDGES, handle)).toBeNull();
	});

	it('requires both values before calling anything', async () => {
		const { fetch } = stubServices();

		const res = await call(`/configure/${newHandle()}`, form({ marqueeToken: TOKEN }));

		expect(res.status).toBe(400);
		expect(await res.text()).toContain('Both values are required');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('replaces the record when the same handle is paired again', async () => {
		stubServices({ authKey: 'rotated-key' });
		const { handle, bindings } = await paired();

		await call(
			`/configure/${handle}`,
			form({ marqueeToken: TOKEN, stremioAuthKey: 'rotated-key' }),
			bindings
		);

		expect(await readBridge(bindings.BRIDGES, handle)).toMatchObject({
			stremioAuthKey: 'rotated-key'
		});
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
		expect(await res.json()).toEqual({ success: true });
		expect(spy).toHaveBeenCalledWith(
			'[event] {"type":"movie","id":"tt0133093","action":"watched","videoIds":[]}'
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
			'[event] {"type":"show","id":"tt0944947","action":"watched","videoIds":["tt0944947:1:1","tt0944947:1:2"]}'
		);
	});

	// Stremio ignores the reply and never retries, so a deliberate drop still says success —
	// answering anything else would only make the client retry what we chose to ignore.
	it('acknowledges an event it deliberately drops', async () => {
		const spy = log();
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

		expect(spy).toHaveBeenCalledWith('[event] ignored type:channel');
		expect(spy).toHaveBeenCalledWith('[event] ignored action:played');
	});

	it('404s a malformed event rather than acknowledging it', async () => {
		const { handle, bindings } = await paired();

		for (const extra of ['action=watched&videoId=tt%', 'action=watched&videoId=tt1.jsonx']) {
			const res = await call(`/${handle}/library/movie/tt1/${extra}`, undefined, bindings);
			expect(res.status).toBe(404);
		}

		expect((await call(`/${handle}/library/movie`, undefined, bindings)).status).toBe(404);
	});

	it('404s an event for an unknown handle', async () => {
		const res = await call(`/${newHandle()}/library/movie/tt1/action=watched.json`);

		expect(res.status).toBe(404);
	});
});
