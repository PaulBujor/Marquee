import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createEvent, type ServerEvent } from '$lib/sync/events';
import { setActiveUser } from '$lib/client/idb/db';
import { enqueueEvent, getUnsynced } from '$lib/client/idb/outbox';
import { getTracking } from '$lib/client/idb/state';
import { getCursor } from '$lib/client/idb/meta';
import type { SyncRequest, SyncResponse } from '$lib/sync/protocol';
import { runSync, SyncError, toSyncErrorInfo } from './sync';

setActiveUser('sync-test-user');
const DEVICE = '11111111-1111-1111-1111-111111111111';

/** A server-shaped pulled event for a given aggregate + sequence. */
function pulled(entityId: string, sequence: number, clock: number): ServerEvent {
	return {
		...createEvent('tracking.added', entityId, { status: 'watching' }, DEVICE),
		userId: 'u1',
		sequence,
		serverReceivedAt: clock,
		clientCreatedAt: clock
	};
}

/** A fetch stub that replies with the given responses in order, capturing each request. */
function stub(responses: SyncResponse[]) {
	const requests: SyncRequest[] = [];
	let call = 0;
	const fetchFn = (async (_url: string, init: RequestInit) => {
		requests.push(JSON.parse(init.body as string) as SyncRequest);
		const body = responses[Math.min(call++, responses.length - 1)];
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	}) as unknown as typeof fetch;
	return { fetchFn, requests };
}

describe('toSyncErrorInfo', () => {
	it('captures message, HTTP status, attempt and time from a SyncError', () => {
		expect(toSyncErrorInfo(new SyncError(503), 2, 1234)).toEqual({
			message: 'sync failed: HTTP 503',
			status: 503,
			attempt: 2,
			at: 1234
		});
	});

	it('captures a generic error with no HTTP status', () => {
		expect(toSyncErrorInfo(new Error('boom'), 0, 5)).toEqual({
			message: 'boom',
			status: undefined,
			attempt: 0,
			at: 5
		});
	});
});

describe('runSync', () => {
	it('pushes unsynced events, applies pulled events, advances the cursor', async () => {
		const local = createEvent('tracking.favorite_toggled', 'movie/x', { favorite: true }, DEVICE);
		await enqueueEvent(local);

		const { fetchFn, requests } = stub([
			{ cursor: 5, events: [pulled('agg-1', 5, 1000)], applied: [local.id], hasMore: false }
		]);
		const result = await runSync(fetchFn);

		expect(requests[0].events).toHaveLength(1); // pushed the local event
		expect(requests[0].events[0].id).toBe(local.id);
		expect(await getUnsynced()).toHaveLength(0); // acked → cleared from the outbox
		expect(await getCursor()).toBe(5);
		expect((await getTracking()).find((t) => t.mediaId === 'agg-1')?.status).toBe('watching');
		expect(result).toEqual({ pushed: 1, pulled: 1 });
	});

	it('loops until the server reports no more pages', async () => {
		const { fetchFn, requests } = stub([
			{ cursor: 1, events: [pulled('agg-a', 1, 1000)], applied: [], hasMore: true },
			{ cursor: 2, events: [pulled('agg-b', 2, 1001)], applied: [], hasMore: false }
		]);
		const result = await runSync(fetchFn);

		expect(requests).toHaveLength(2);
		expect(requests[1].cursor).toBe(1); // second request resumes from the advanced cursor
		expect(await getCursor()).toBe(2);
		expect(result.pulled).toBe(2);
	});

	it('throws on a non-ok response so the caller can back off', async () => {
		const fetchFn = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
		await expect(runSync(fetchFn)).rejects.toThrow();
	});
});
