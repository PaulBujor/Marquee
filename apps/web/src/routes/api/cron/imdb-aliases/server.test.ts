import { describe, expect, it } from 'vitest';
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

function fakeQueue() {
	const sent: unknown[] = [];
	return {
		sent,
		binding: {
			async sendBatch(messages: Iterable<{ body: unknown }>) {
				for (const m of messages) sent.push(m.body);
				return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
			}
		}
	};
}

function makeEvent(opts: {
	db?: ReturnType<typeof createTestDb>;
	header?: string | null;
	tmdbKey?: string | null;
	queue?: unknown;
}): RequestEvent {
	const { db, header = SECRET, tmdbKey = 'tmdb-key', queue = fakeQueue().binding } = opts;
	const request = new Request('https://app/api/cron/imdb-aliases', {
		method: 'POST',
		headers: header === null ? {} : { 'x-cron-key': header }
	});
	setTestBindings({
		CRON_SECRET: SECRET,
		IMDB_ALIAS_QUEUE: queue,
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

async function seedUnasked(db: ReturnType<typeof createTestDb>, stamped = false) {
	await db.insert(media).values({
		id: seedMediaId('tmdb', 'movie/603'),
		provider: 'tmdb',
		externalId: 'movie/603',
		source: 'linked',
		type: 'movie',
		title: 'The Matrix',
		version: 1,
		refreshedAt: T0,
		imdbCheckedAt: stamped ? T0 : null
	});
}

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

	// Enqueueing without a key would 503 every batch and dead-letter the whole backlog behind a healthy-looking run.
	it('no-ops without enqueueing when TMDB is not configured', async () => {
		const db = createTestDb();
		await seedUnasked(db);
		const queue = fakeQueue();

		const body = (await (
			await POST(makeEvent({ db, tmdbKey: null, queue: queue.binding }))
		).json()) as { ok: boolean; error?: string };

		expect(body.ok).toBe(false);
		expect(body.error).toMatch(/TMDB/);
		expect(queue.sent).toEqual([]);
	});

	it('enqueues one message per unasked title on the IMDB_ALIAS_QUEUE binding', async () => {
		const db = createTestDb();
		await seedUnasked(db);
		const queue = fakeQueue();

		const body = (await (await POST(makeEvent({ db, queue: queue.binding }))).json()) as {
			ok: boolean;
			queued: number;
		};

		expect(body).toMatchObject({ ok: true, queued: 1 });
		expect(queue.sent).toEqual([
			{ mediaId: seedMediaId('tmdb', 'movie/603'), provider: 'tmdb', externalId: 'movie/603' }
		]);
	});

	it('enqueues nothing for a title already asked', async () => {
		const db = createTestDb();
		await seedUnasked(db, true);
		const queue = fakeQueue();

		await POST(makeEvent({ db, queue: queue.binding }));

		expect(queue.sent).toEqual([]);
	});
});
