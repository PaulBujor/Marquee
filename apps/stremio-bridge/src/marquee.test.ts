import { describe, expect, it } from 'vitest';
import {
	applyCommands,
	listLibrary,
	MarqueeError,
	type LibraryEntry,
	type MarqueeClient
} from './marquee';

const MARQUEE = 'https://marquee.test';
const TOKEN = 'mqr_test_token';

/**
 * Answers only the URLs a test registers and throws on anything else, so a request the client makes
 * of its own accord cannot pass unnoticed.
 */
function stubFetch(routes: Record<string, () => Response>) {
	const calls: { url: string; init?: RequestInit }[] = [];

	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		const route = routes[url];
		if (!route) throw new Error(`unexpected fetch: ${url}`);

		calls.push({ url, init });
		return route();
	}) as typeof fetch;

	return { fetchImpl, calls };
}

const client = (fetchImpl: typeof fetch): MarqueeClient => ({
	marqueeUrl: MARQUEE,
	token: TOKEN,
	fetchImpl
});

const entry = (mediaId: string): LibraryEntry => ({
	tracking: { mediaId, status: 'watching', removed: false },
	media: { id: mediaId, type: 'show' },
	episodes: [{ season: 1, episode: 1, watched: true }]
});

const page = (entries: LibraryEntry[], nextCursor: string | null) =>
	Response.json({ entries, nextCursor });

describe('listLibrary', () => {
	it('walks the cursor to the end', async () => {
		const { fetchImpl, calls } = stubFetch({
			[`${MARQUEE}/api/v1/library`]: () => page([entry('a')], 'next'),
			[`${MARQUEE}/api/v1/library?cursor=next`]: () => page([entry('b')], null)
		});

		const entries = await listLibrary(client(fetchImpl));

		expect(entries.map((e) => e.tracking.mediaId)).toEqual(['a', 'b']);
		expect(calls.map((c) => c.url)).toEqual([
			`${MARQUEE}/api/v1/library`,
			`${MARQUEE}/api/v1/library?cursor=next`
		]);
	});

	it('reads with the bearer token and never follows a redirect', async () => {
		const { fetchImpl, calls } = stubFetch({ [`${MARQUEE}/api/v1/library`]: () => page([], null) });

		await listLibrary(client(fetchImpl));

		const init = calls[0]?.init;
		expect(init?.method).toBe('GET');
		expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
		// A redirect would carry the bearer wherever it points.
		expect(init?.redirect).toBe('manual');
	});

	it.each([401, 403, 429, 500, 503])('throws a typed error for %i', async (status) => {
		const { fetchImpl } = stubFetch({
			[`${MARQUEE}/api/v1/library`]: () => new Response('nope', { status })
		});

		const error = await listLibrary(client(fetchImpl)).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(MarqueeError);
		// The status is the whole point: 401 means pair again, 429 and 5xx mean wait.
		expect((error as MarqueeError).status).toBe(status);
	});

	// A 200 that is not the envelope must not read as an empty library.
	it('refuses a success that is not JSON', async () => {
		const { fetchImpl } = stubFetch({
			[`${MARQUEE}/api/v1/library`]: () => new Response('<html>', { status: 200 })
		});

		const error = await listLibrary(client(fetchImpl)).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(MarqueeError);
		expect((error as MarqueeError).message).toMatch(/JSON/);
	});
});

describe('applyCommands', () => {
	it('posts the batch and returns what the receiver did', async () => {
		const result = { applied: 1, unchanged: 0, failed: [] };
		const { fetchImpl, calls } = stubFetch({
			[`${MARQUEE}/api/v1/library`]: () => Response.json(result)
		});

		const items = [{ type: 'show' as const, id: 'tt0944947', removed: false }];
		await expect(applyCommands(client(fetchImpl), items)).resolves.toEqual(result);

		const init = calls[0]?.init;
		expect(init?.method).toBe('POST');
		expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
		expect(JSON.parse(String(init?.body))).toEqual({ items });
	});

	it('throws a typed error rather than a half-read batch', async () => {
		const { fetchImpl } = stubFetch({
			[`${MARQUEE}/api/v1/library`]: () => Response.json({ title: 'Bad request' }, { status: 400 })
		});

		const error = await applyCommands(client(fetchImpl), []).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(MarqueeError);
		expect((error as MarqueeError).status).toBe(400);
	});
});
