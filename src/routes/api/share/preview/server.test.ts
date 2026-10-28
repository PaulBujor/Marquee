import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '$lib/server/db/test-db';
import { sharePreviewWarms, sharePreviews, users } from '$lib/server/db/schema';
import { WARM_MAX_PER_HOUR } from '$lib/server/share/preview';
import { POST } from './+server';

type Handler = typeof POST;
type Event = Parameters<Handler>[0];

const USER_ID = 'user-1';

const MOVIE = {
	id: 603,
	title: 'The Matrix',
	release_date: '1999-03-31',
	overview: 'A hacker learns the truth.',
	poster_path: '/matrix.jpg'
};

async function makeDb() {
	const db = createTestDb();
	await db.insert(users).values({ id: USER_ID, email: 'sharer@example.com', status: 'enabled' });
	return db;
}

function makeEvent(opts: {
	db: Awaited<ReturnType<typeof makeDb>>;
	user?: unknown;
	body?: unknown;
	rawBody?: string;
	apiKey?: string | null;
}) {
	const { db, user = { id: USER_ID }, apiKey = 'key' } = opts;
	const request = new Request('http://localhost/api/share/preview', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: opts.rawBody ?? JSON.stringify(opts.body ?? { kind: 'movie' })
	});
	const platform = apiKey === null ? { env: {} } : { env: { TMDB_API_KEY: apiKey } };
	return { locals: { user, db }, platform, request } as unknown as Event;
}

/** The handler answers with a Response or throws an `error()` — both are just a status here. */
async function statusOf(run: () => unknown): Promise<number> {
	try {
		const res = (await run()) as Response;
		return res.status;
	} catch (err) {
		return (err as { status?: number }).status ?? 0;
	}
}

function stubFetch(body: unknown, status = 200) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(JSON.stringify(body), { status }))
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('POST /api/share/preview', () => {
	it('401s when signed out — warming requires an account', async () => {
		const db = await makeDb();
		expect(await statusOf(() => POST(makeEvent({ db, user: null })))).toBe(401);
		expect(await db.select().from(sharePreviews)).toHaveLength(0);
	});

	it('400s on a body that is not JSON, and on one that is not a target', async () => {
		const db = await makeDb();
		expect(await statusOf(() => POST(makeEvent({ db, rawBody: '{oops' })))).toBe(400);
		expect(
			await statusOf(() =>
				POST(makeEvent({ db, body: { kind: 'title', type: 'movie', id: '603' } }))
			)
		).toBe(400);
		expect(await statusOf(() => POST(makeEvent({ db, body: { kind: 'person', id: -1 } })))).toBe(
			400
		);
		expect(await statusOf(() => POST(makeEvent({ db, body: { kind: 'album', id: 3 } })))).toBe(400);
	});

	it('503s when the provider is not configured', async () => {
		const db = await makeDb();
		expect(
			await statusOf(() =>
				POST(makeEvent({ db, apiKey: null, body: { kind: 'title', type: 'movie', id: 603 } }))
			)
		).toBe(503);
	});

	it('warms a title and reports it', async () => {
		const db = await makeDb();
		stubFetch(MOVIE);
		const res = await POST(makeEvent({ db, body: { kind: 'title', type: 'movie', id: 603 } }));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'warmed' });
		const rows = await db.select().from(sharePreviews);
		expect(rows).toHaveLength(1);
		expect(rows[0].name).toBe('The Matrix');
	});

	it('warms a person, keeping only the card-sized stub', async () => {
		const db = await makeDb();
		stubFetch({
			id: 287,
			name: 'Brad Pitt',
			biography: 'An actor.',
			profile_path: '/pitt.jpg',
			combined_credits: {
				cast: [{ id: 1, media_type: 'movie', title: 'Se7en', release_date: '1995-09-22' }]
			}
		});
		const res = await POST(makeEvent({ db, body: { kind: 'person', id: 287 } }));

		expect(res.status).toBe(200);
		const rows = await db.select().from(sharePreviews);
		expect(rows[0].kind).toBe('person');
		expect(JSON.parse(rows[0].knownFor ?? '[]')).toEqual(['Se7en (1995)']);
	});

	it('404s when the provider has never heard of it', async () => {
		const db = await makeDb();
		stubFetch({ status_message: 'not found' }, 404);
		const res = await POST(makeEvent({ db, body: { kind: 'title', type: 'movie', id: 999999 } }));
		expect(res.status).toBe(404);
		expect(await db.select().from(sharePreviews)).toHaveLength(0);
	});

	it('429s once the account is at its hourly cap, without calling the provider', async () => {
		const db = await makeDb();
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		await db.insert(sharePreviewWarms).values(
			Array.from({ length: WARM_MAX_PER_HOUR }, (_, i) => ({
				id: `warm-${i}`,
				userId: USER_ID,
				createdAt: new Date()
			}))
		);

		const res = await POST(makeEvent({ db, body: { kind: 'title', type: 'movie', id: 603 } }));
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ status: 'rate_limited' });
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
