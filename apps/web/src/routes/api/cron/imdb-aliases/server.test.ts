import { afterEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { createTestDb } from '#lib/server/db/test-db.js';
import { media } from '#lib/server/db/schema.js';
import { seedMediaId } from '#lib/sync/events.js';
import { setTestBindings } from '#lib/server/test/cloudflare-workers.js';
import { POST } from './+server';

type Handler = typeof POST;
type RequestEvent = Parameters<Handler>[0];

const SECRET = 'cron-secret';
const T0 = Date.UTC(2026, 6, 24);

function makeEvent(opts: {
	db?: ReturnType<typeof createTestDb>;
	header?: string | null;
	tmdbKey?: string | null;
}): RequestEvent {
	const { db, header = SECRET, tmdbKey = 'tmdb-key' } = opts;
	const request = new Request('https://app/api/cron/imdb-aliases', {
		method: 'POST',
		headers: header === null ? {} : { 'x-cron-key': header }
	});
	setTestBindings({
		CRON_SECRET: SECRET,
		...(tmdbKey === null ? {} : { TMDB_API_KEY: tmdbKey })
	});
	return {
		request,
		url: new URL('https://app/api/cron/imdb-aliases'),
		locals: { db }
	} as unknown as RequestEvent;
}

async function thrownBy(run: () => unknown): Promise<{ status: number }> {
	try {
		await run();
		throw new Error('expected the handler to throw');
	} catch (err) {
		return err as { status: number };
	}
}

async function seedUnasked(db: ReturnType<typeof createTestDb>) {
	await db.insert(media).values({
		id: seedMediaId('tmdb', 'movie/603'),
		provider: 'tmdb',
		externalId: 'movie/603',
		source: 'linked',
		type: 'movie',
		title: 'The Matrix',
		version: 1,
		refreshedAt: T0
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('POST /api/cron/imdb-aliases', () => {
	it('401s without a valid x-cron-key', async () => {
		const err = await thrownBy(() => POST(makeEvent({ header: 'wrong' })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(401);
	});

	it('401s with no header at all', async () => {
		expect((await thrownBy(() => POST(makeEvent({ header: null })))).status).toBe(401);
	});

	it('503s without a db', async () => {
		expect((await thrownBy(() => POST(makeEvent({ db: undefined })))).status).toBe(503);
	});

	// A 200 that stamped nothing would read as a healthy run, so the absence is reported instead.
	it('no-ops when TMDB is not configured', async () => {
		const db = createTestDb();
		await seedUnasked(db);
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);

		const body = (await (await POST(makeEvent({ db, tmdbKey: null }))).json()) as {
			ok: boolean;
			error?: string;
		};

		expect(body.ok).toBe(false);
		expect(body.error).toMatch(/TMDB/);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('backfills the alias and returns the summary', async () => {
		const db = createTestDb();
		await seedUnasked(db);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ id: 603, imdb_id: 'tt0133093' }))
		);

		const body = (await (await POST(makeEvent({ db }))).json()) as {
			ok: boolean;
			aliased: number;
			noId: number;
			failed: number;
		};

		expect(body).toMatchObject({ ok: true, aliased: 1, noId: 0, failed: 0 });
		const [row] = await db.select().from(media);
		expect(row.imdbCheckedAt).not.toBeNull();
	});
});
