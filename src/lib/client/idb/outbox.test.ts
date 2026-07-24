import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createEvent } from '$lib/sync/events';
import { setActiveUser } from './db';
import { enqueueEvent, getUnsynced, markSynced } from './outbox';

setActiveUser('test-user'); // the store is namespaced per user; scope it before opening

const DEVICE = '11111111-1111-1111-1111-111111111111';

/** Enqueue an event with an explicit clock so ordering is deterministic. */
async function enqueue(clock: number) {
	const e = createEvent('tracking.favorite_toggled', `movie:${clock}`, { favorite: true }, DEVICE);
	e.clientCreatedAt = clock;
	await enqueueEvent(e);
	return e;
}

describe('outbox', () => {
	it('returns unsynced events oldest-first as bare envelopes', async () => {
		const a = await enqueue(1000);
		await enqueue(1002);
		await enqueue(1001);
		const unsynced = await getUnsynced();
		const forMine = unsynced.filter((e) => [1000, 1001, 1002].includes(e.clientCreatedAt));
		expect(forMine.map((e) => e.clientCreatedAt)).toEqual([1000, 1001, 1002]);
		// bare wire shape — no local `synced` flag leaks
		expect(a).not.toHaveProperty('synced');
		expect(unsynced[0]).not.toHaveProperty('synced');
	});

	it('honors the page limit', async () => {
		await enqueue(2000);
		await enqueue(2001);
		const page = await getUnsynced(1);
		expect(page).toHaveLength(1);
	});

	it('stops returning events once marked synced', async () => {
		const e = await enqueue(3000);
		await markSynced([e.id]);
		const unsynced = await getUnsynced();
		expect(unsynced.some((x) => x.id === e.id)).toBe(false);
	});
});
