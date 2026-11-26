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
 * Answers only the URLs a test registers — or, for a read that never ends, whatever `fallback` says —
 * and throws on anything else, so a request the client makes of its own accord cannot go unnoticed.
 */
function stubFetch(routes: Record<string, () => Response>, fallback?: (url: URL) => Response) {
	const calls: { url: string; init?: RequestInit }[] = [];

	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		calls.push({ url, init });

		const route = routes[url];
		if (route) return route();
		if (fallback) return fallback(new URL(url));
		throw new Error(`unexpected fetch: ${url}`);
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

	// A receiver whose cursor echoes or never ends must not be paged until the Worker is killed.
	it('stops on a cursor that does not advance', async () => {
		const { fetchImpl, calls } = stubFetch({}, () => page([], 'same'));

		const error = await listLibrary(client(fetchImpl)).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(MarqueeError);
		expect((error as MarqueeError).message).toMatch(/repeated a cursor/);
		expect(calls).toHaveLength(2);
	});

	it('stops paging a cursor that never ends', async () => {
		const { fetchImpl, calls } = stubFetch({}, (url) =>
			page([], String(Number(url.searchParams.get('cursor') ?? 0) + 1))
		);

		const error = await listLibrary(client(fetchImpl)).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(MarqueeError);
		expect((error as MarqueeError).message).toMatch(/longer than/);
		expect(calls).toHaveLength(100);
	});

	// A 200 whose body is not a page must not read as a library — nor as a string's characters.
	it('refuses a success that is not a page of entries', async () => {
		const { fetchImpl } = stubFetch({
			[`${MARQUEE}/api/v1/library`]: () => Response.json({ entries: 'oops', nextCursor: null })
		});

		const error = await listLibrary(client(fetchImpl)).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(MarqueeError);
		expect((error as MarqueeError).status).toBe(200);
	});

	it('reports a call that never got an answer as status 0', async () => {
		for (const failure of [
			new TypeError('fetch failed'),
			Object.assign(new Error('timed out'), { name: 'TimeoutError' })
		]) {
			const fetchImpl = (async () => {
				throw failure;
			}) as typeof fetch;

			const error = await listLibrary(client(fetchImpl)).catch((err: unknown) => err);

			expect(error).toBeInstanceOf(MarqueeError);
			expect((error as MarqueeError).status).toBe(0);
			expect((error as MarqueeError).message).toContain(failure.name);
		}
	});

	// A 400 from one bad item has to say which field it refused, or it is undiagnosable.
	it('carries the problem detail of a refusal, capped', async () => {
		const detail = `items[3].episodes: ${'x'.repeat(500)}`;

		const { fetchImpl } = stubFetch({
			[`${MARQUEE}/api/v1/library`]: () =>
				Response.json({ title: 'Bad request', detail }, { status: 400 })
		});

		const error = await listLibrary(client(fetchImpl)).catch((err: unknown) => err);

		expect((error as MarqueeError).status).toBe(400);
		expect((error as MarqueeError).message).toBe(`Marquee answered 400: ${detail.slice(0, 200)}`);
	});

	it('names no detail when the refusal carries none', async () => {
		const { fetchImpl } = stubFetch({
			[`${MARQUEE}/api/v1/library`]: () => new Response('gateway', { status: 502 })
		});

		const error = await listLibrary(client(fetchImpl)).catch((err: unknown) => err);

		expect((error as MarqueeError).message).toBe('Marquee answered 502');
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

		const error = await applyCommands(client(fetchImpl), [
			{ type: 'movie', id: 'tt0133093', status: 'completed' }
		]).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(MarqueeError);
		expect((error as MarqueeError).status).toBe(400);
	});

	// A plan with nothing to apply is not a request: the stub throws on any call.
	it('sends nothing for an empty plan', async () => {
		const { fetchImpl, calls } = stubFetch({});

		await expect(applyCommands(client(fetchImpl), [])).resolves.toEqual({
			applied: 0,
			unchanged: 0,
			failed: []
		});
		expect(calls).toEqual([]);
	});

	// The receiver refuses an oversized batch outright, and a refusal applies nothing at all.
	it('splits a batch at the receiver’s ceiling and merges the results', async () => {
		const { fetchImpl, calls } = stubFetch({
			[`${MARQUEE}/api/v1/library`]: () => Response.json({ applied: 1, unchanged: 0, failed: [] })
		});

		const items = Array.from({ length: 501 }, (_, index) => ({
			type: 'movie' as const,
			id: `tt${1000 + index}`
		}));

		await expect(applyCommands(client(fetchImpl), items)).resolves.toEqual({
			applied: 2,
			unchanged: 0,
			failed: []
		});

		expect(calls).toHaveLength(2);
		expect(JSON.parse(String(calls[0]?.init?.body)).items).toHaveLength(500);
		expect(JSON.parse(String(calls[1]?.init?.body)).items).toHaveLength(1);
	});

	// One command naming a whole series is refused too, so it goes as several items in one batch.
	it('splits one item’s episodes at the receiver’s ceiling', async () => {
		const { fetchImpl, calls } = stubFetch({
			[`${MARQUEE}/api/v1/library`]: () => Response.json({ applied: 2, unchanged: 0, failed: [] })
		});

		const episodes = Array.from({ length: 501 }, (_, index) => ({
			season: 1,
			episode: index + 1,
			watched: true
		}));

		await applyCommands(client(fetchImpl), [
			{ type: 'show', id: 'tt0944947', removed: false, episodes }
		]);

		expect(calls).toHaveLength(1);
		const sent = JSON.parse(String(calls[0]?.init?.body)).items;
		expect(sent).toHaveLength(2);
		expect(sent[0].episodes).toHaveLength(500);
		expect(sent[1].episodes).toEqual([{ season: 1, episode: 501, watched: true }]);
	});

	it('refuses a batch result it cannot read', async () => {
		const { fetchImpl } = stubFetch({
			[`${MARQUEE}/api/v1/library`]: () => Response.json({ ok: true })
		});

		const error = await applyCommands(client(fetchImpl), [
			{ type: 'movie', id: 'tt0133093', removed: false }
		]).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(MarqueeError);
		expect((error as MarqueeError).status).toBe(200);
	});
});
