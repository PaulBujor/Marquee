import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '$lib/server/db/test-db';
import { sharePreviews, users } from '$lib/server/db/schema';
import { previewId } from '$lib/server/share/preview';
import { PUBLIC_SHARE_HEADERS } from '$lib/server/share/public';
import { load } from './+page.server';

type Event = Parameters<typeof load>[0];

const MOVIE = {
	id: 603,
	title: 'The Matrix',
	release_date: '1999-03-31',
	overview: 'A hacker learns the truth.',
	poster_path: '/matrix.jpg'
};

async function setup(
	opts: {
		user?: { id: string } | null;
		type?: string;
		id?: string;
		withDb?: boolean;
		disabled?: boolean;
		warmed?: boolean;
		limited?: boolean;
	} = {}
) {
	const db = createTestDb();
	await db.insert(users).values({ id: 'user-1', email: 'sharer@example.com', status: 'enabled' });
	if (opts.warmed) {
		await db.insert(sharePreviews).values({
			id: previewId('movie', 603),
			provider: 'tmdb',
			externalId: '603',
			titleType: 'movie',
			name: 'The Matrix',
			year: 1999,
			summary: 'A hacker learns the truth.',
			imagePath: '/matrix.jpg',
			backdropPath: '/matrix-backdrop.jpg',
			rating: 8.2,
			runtime: 136,
			releasedOn: '1999-03-31',
			seasons: 0,
			genres: JSON.stringify(['Action', 'Science Fiction']),
			crew: JSON.stringify({
				director: 'Lana Wachowski',
				creators: [],
				writers: ['Lilly Wachowski'],
				producers: []
			}),
			cast: JSON.stringify([{ name: 'Keanu Reeves', profilePath: '/keanu.jpg' }]),
			updatedAt: new Date()
		});
	}

	const headers: Record<string, string> = {};
	const pending: Promise<unknown>[] = [];
	const limitKeys: string[] = [];
	const event = {
		params: { type: opts.type ?? 'movie', id: opts.id ?? '603' },
		request: new Request('https://marquee.example/s/movie/603', {
			headers: { 'cf-connecting-ip': '203.0.113.9' }
		}),
		locals: { user: opts.user ?? null, db: opts.withDb === false ? undefined : db },
		platform: {
			env: {
				...(opts.disabled ? { SHARE_PUBLIC_DISABLED: '1' } : {}),
				TMDB_API_KEY: 'key',
				PUBLIC_SHARE_LIMITER: {
					limit: async ({ key }: { key: string }) => {
						limitKeys.push(key);
						return { success: !opts.limited };
					}
				}
			},
			ctx: { waitUntil: (promise: Promise<unknown>) => pending.push(promise) }
		},
		setHeaders: (values: Record<string, string>) => {
			for (const key in values) {
				// SvelteKit throws when one header is set twice in a request ("header is already set"),
				// so this double does too: `Object.assign` hid that from the tests once already.
				if (key.toLowerCase() in headers) throw new Error(`"${key}" header is already set`);
				headers[key] = values[key];
			}
		}
	} as unknown as Event;

	return { event, headers, db, pending, limitKeys };
}

/** The load answers with page data, or throws an `error()`/`redirect()`. */
async function outcome(run: () => unknown) {
	try {
		return { data: (await run()) as Record<string, unknown> };
	} catch (err) {
		return { err: err as { status?: number; location?: string } };
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('GET /s/[type]/[id]', () => {
	it('404s on a type that is not a movie or a show, and on a nonsense id', async () => {
		for (const opts of [
			{ type: 'book' },
			{ id: 'abc' },
			{ id: '0' },
			{ id: '-3' },
			{ id: '1.5' }
		]) {
			const { event } = await setup(opts);
			expect((await outcome(() => load(event))).err?.status).toBe(404);
		}
	});

	it('503s without the platform bindings', async () => {
		const { event } = await setup({ withDb: false });
		expect((await outcome(() => load(event))).err?.status).toBe(503);
	});

	it('renders a warmed card anonymously, and never calls the provider', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const { event, headers } = await setup({ warmed: true });

		const { data } = await outcome(() => load(event));

		expect(data).toMatchObject({
			state: 'ready',
			preview: { name: 'The Matrix', rating: 8.2, genres: ['Action', 'Science Fiction'] }
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(headers).toEqual(PUBLIC_SHARE_HEADERS);
	});

	it('never lets a shared page be cached, so a signed-in reader is not served an anonymous copy', async () => {
		const { event, headers } = await setup({ warmed: true });
		await outcome(() => load(event));

		expect(headers['cache-control']).toBe('no-store');
		expect(headers['x-robots-tag']).toBe('noindex, noarchive');
	});

	it('sheds a flood before reading anything, and says so in the log', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { event, headers, limitKeys } = await setup({ warmed: true, limited: true });

		const { err } = await outcome(() => load(event));

		expect(err?.status).toBe(429);
		expect(limitKeys).toEqual(['ip:203.0.113.9']);
		// Countable in Workers Logs, since rate-limit bindings aren't visible in the dashboard.
		expect(warn).toHaveBeenCalledWith('rate limit: shed share request for /s/movie/603');
		// The policy goes on before the guards, so even a refusal is no-store and noindex.
		expect(headers).toEqual(PUBLIC_SHARE_HEADERS);
		warn.mockRestore();
	});

	it('serves the cold state for a link nothing has warmed — still without the provider', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const { event, headers } = await setup();

		const { data } = await outcome(() => load(event));

		expect(data).toMatchObject({ state: 'cold', type: 'movie', id: 603 });
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(headers).toEqual(PUBLIC_SHARE_HEADERS);
	});

	it('serves the disabled state when public sharing is switched off', async () => {
		const { event, headers } = await setup({ disabled: true, warmed: true });
		const { data } = await outcome(() => load(event));
		expect(data?.state).toBe('disabled');
		expect(headers).toEqual(PUBLIC_SHARE_HEADERS);
	});

	it('sends a signed-in reader to the real page, warming the card on the way', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify(MOVIE)))
		);
		const { event, headers, db, pending } = await setup({ user: { id: 'user-1' } });

		const { err } = await outcome(() => load(event));

		expect(err?.status).toBe(303);
		expect(err?.location).toBe('/title/movie/603');
		// One policy for every outcome: `no-store` can't be stored by any cache, so the redirect a
		// signed-in reader gets needs nothing narrower — and setting a second header set would throw.
		expect(headers).toEqual(PUBLIC_SHARE_HEADERS);

		// The warm was detached, and it lands: the card is there for the next reader.
		expect(pending).toHaveLength(1);
		await Promise.all(pending);
		const rows = await db.select().from(sharePreviews);
		expect(rows[0]?.name).toBe('The Matrix');
	});
});
