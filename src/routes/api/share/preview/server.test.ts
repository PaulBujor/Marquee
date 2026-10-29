import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '#lib/server/db/test-db.js';
import { sharePreviewWarms, sharePreviews, users } from '#lib/server/db/schema.js';
import { WARM_MAX_PER_HOUR } from '#lib/server/share/preview.js';
import { POST } from './+server';
import { setTestBindings } from '#lib/server/test/cloudflare-workers.js';

type Handler = typeof POST;
type Event = Parameters<Handler>[0];

const USER_ID = 'user-1';

const MOVIE = {
	id: 603,
	title: 'The Matrix',
	release_date: '1999-03-31',
	overview: 'A hacker learns the truth.',
	poster_path: '/matrix.jpg',
	backdrop_path: '/matrix-backdrop.jpg',
	vote_average: 8.2,
	runtime: 136,
	genres: [{ id: 28, name: 'Action' }],
	credits: {
		cast: [{ id: 1, name: 'Keanu Reeves', character: 'Neo', profile_path: '/keanu.jpg' }],
		crew: [{ id: 2, name: 'Lana Wachowski', job: 'Director' }]
	}
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
	disabled?: boolean;
}) {
	const { db, user = { id: USER_ID }, apiKey = 'key' } = opts;
	const request = new Request('http://localhost/api/share/preview', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: opts.rawBody ?? JSON.stringify(opts.body ?? { type: 'movie', id: 603 })
	});
	const env = {
		...(apiKey === null ? {} : { TMDB_API_KEY: apiKey }),
		...(opts.disabled ? { SHARE_PUBLIC_DISABLED: '1' } : {})
	};
	setTestBindings(env);
	return { locals: { user, db }, request } as unknown as Event;
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
	it('503s when the surface is switched off, so nothing is stored for a dead surface', async () => {
		const db = await makeDb();
		const event = makeEvent({ db, disabled: true });

		expect(await statusOf(() => POST(event))).toBe(503);
		expect(await db.select().from(sharePreviews)).toHaveLength(0);
	});

	it('401s when signed out — warming requires an account', async () => {
		const db = await makeDb();
		expect(await statusOf(() => POST(makeEvent({ db, user: null })))).toBe(401);
		expect(await db.select().from(sharePreviews)).toHaveLength(0);
	});

	it('400s on a body that is not JSON, and on one that is not a shareable target', async () => {
		const db = await makeDb();
		expect(await statusOf(() => POST(makeEvent({ db, rawBody: '{oops' })))).toBe(400);
		expect(await statusOf(() => POST(makeEvent({ db, body: { type: 'movie', id: '603' } })))).toBe(
			400
		);
		expect(await statusOf(() => POST(makeEvent({ db, body: { type: 'movie', id: -1 } })))).toBe(
			400
		);
		// A person is no longer a shareable target.
		expect(await statusOf(() => POST(makeEvent({ db, body: { kind: 'person', id: 287 } })))).toBe(
			400
		);
	});

	it('503s when the provider is not configured', async () => {
		const db = await makeDb();
		expect(
			await statusOf(() => POST(makeEvent({ db, apiKey: null, body: { type: 'movie', id: 603 } })))
		).toBe(503);
	});

	it('warms a title and reports it', async () => {
		const db = await makeDb();
		stubFetch(MOVIE);
		const res = await POST(makeEvent({ db, body: { type: 'movie', id: 603 } }));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'warmed' });
		const rows = await db.select().from(sharePreviews);
		expect(rows).toHaveLength(1);
		expect(rows[0].name).toBe('The Matrix');
		expect(rows[0].backdropPath).toBe('/matrix-backdrop.jpg');
	});

	it('404s when the provider has never heard of it', async () => {
		const db = await makeDb();
		stubFetch({ status_message: 'not found' }, 404);
		const res = await POST(makeEvent({ db, body: { type: 'movie', id: 999999 } }));
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

		const res = await POST(makeEvent({ db, body: { type: 'movie', id: 603 } }));
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ status: 'rate_limited' });
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
