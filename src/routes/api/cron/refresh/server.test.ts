import { afterEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { createTestDb } from '$lib/server/db/test-db';
import { media } from '$lib/server/db/schema';
import { mediaId } from '$lib/sync/events';
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
	force?: boolean;
	queue?: unknown;
}): RequestEvent {
	const { db, header = SECRET, force = false, queue = fakeQueue().binding } = opts;
	const request = new Request('https://app/api/cron/refresh', {
		method: 'POST',
		headers: header === null ? {} : { 'x-cron-key': header }
	});
	const url = new URL(`https://app/api/cron/refresh${force ? '?force=1' : ''}`);
	const platform = { env: { CRON_SECRET: SECRET, MEDIA_REFRESH_QUEUE: queue } };
	return { request, url, locals: { db }, platform } as unknown as RequestEvent;
}

async function thrownBy(run: () => unknown): Promise<{ status: number }> {
	try {
		await run();
		throw new Error('expected the handler to throw');
	} catch (err) {
		return err as { status: number };
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('POST /api/cron/refresh', () => {
	it('401s without a valid x-cron-key', async () => {
		const err = await thrownBy(() => POST(makeEvent({ header: 'wrong' })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(401);
	});

	it('401s with no header at all', async () => {
		const err = await thrownBy(() => POST(makeEvent({ header: null })));
		expect(err.status).toBe(401);
	});

	it('503s without a db', async () => {
		const err = await thrownBy(() => POST(makeEvent({ db: undefined })));
		expect(err.status).toBe(503);
	});

	it('enqueues unsettled media onto the queue binding and purges auth, without calling TMDB', async () => {
		const db = createTestDb();
		await db.insert(media).values({
			id: mediaId('tmdb', 'show/1'),
			provider: 'tmdb',
			externalId: 'show/1',
			source: 'linked',
			type: 'show',
			title: 'show/1',
			inProduction: true,
			version: 1,
			refreshedAt: 0
		});
		const { sent, binding } = fakeQueue();
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);

		const res = await POST(makeEvent({ db, queue: binding }));
		const body = (await res.json()) as {
			media: { ok: boolean; queued?: number; scanned?: number };
			auth: { ok: boolean };
		};

		expect(body.media).toMatchObject({ ok: true, scanned: 1, queued: 1 });
		expect(body.auth.ok).toBe(true);
		expect(sent).toEqual([{ provider: 'tmdb', externalId: 'show/1' }]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('carries ?force=1 onto the enqueued message', async () => {
		const db = createTestDb();
		await db.insert(media).values({
			id: mediaId('tmdb', 'show/2'),
			provider: 'tmdb',
			externalId: 'show/2',
			source: 'linked',
			type: 'show',
			title: 'show/2',
			inProduction: true,
			version: 1,
			refreshedAt: T0
		});
		const { sent, binding } = fakeQueue();

		await POST(makeEvent({ db, queue: binding, force: true }));

		expect(sent).toEqual([{ provider: 'tmdb', externalId: 'show/2', force: true }]);
	});

	it('isolates a queue failure from the auth purge — auth still runs and reports ok', async () => {
		const db = createTestDb();
		await db.insert(media).values({
			id: mediaId('tmdb', 'show/3'),
			provider: 'tmdb',
			externalId: 'show/3',
			source: 'linked',
			type: 'show',
			title: 'show/3',
			inProduction: true,
			version: 1,
			refreshedAt: 0
		});
		const brokenQueue = {
			async sendBatch() {
				throw new Error('queue unavailable');
			}
		};

		const res = await POST(makeEvent({ db, queue: brokenQueue }));
		const body = (await res.json()) as { media: { ok: boolean }; auth: { ok: boolean } };

		expect(body.media.ok).toBe(false);
		expect(body.auth.ok).toBe(true);
	});
});
