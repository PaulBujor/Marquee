import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createEvent } from '#lib/sync/events.js';
import { setActiveUser } from './db';
import {
	enqueueEvent,
	enqueueEvents,
	getAllEvents,
	getUnsynced,
	markSynced,
	putPulledEvents
} from './outbox';

setActiveUser('test-user'); // the store is namespaced per user; scope it before opening

const DEVICE = '11111111-1111-1111-1111-111111111111';

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

	it('enqueues a batch of events in one call', async () => {
		const batch = [4000, 4001, 4002].map((clock) =>
			createEvent('tracking.added', `movie:${clock}`, { status: 'watching' }, DEVICE, clock)
		);
		await enqueueEvents(batch);

		const unsynced = await getUnsynced();
		const mine = unsynced.filter((e) => batch.some((b) => b.id === e.id));
		expect(mine.map((e) => e.clientCreatedAt)).toEqual([4000, 4001, 4002]);
	});

	it('accepts an empty batch without opening a transaction', async () => {
		await expect(enqueueEvents([])).resolves.toBeUndefined();
	});

	it('keeps pulled events as synced log rows, so history holds other devices too', async () => {
		const pulled = createEvent(
			'tracking.added',
			'movie:5000',
			{ status: 'watching' },
			'other',
			5000
		);
		await putPulledEvents([pulled]);
		await putPulledEvents([pulled]); // idempotent — a re-pull must not duplicate

		const log = await getAllEvents();
		expect(log.filter((e) => e.id === pulled.id)).toHaveLength(1);
		expect(await getUnsynced()).not.toContainEqual(expect.objectContaining({ id: pulled.id }));
	});

	it('never marks a still-unsynced local write as synced when it is pulled back', async () => {
		const local = await enqueue(6000);
		await putPulledEvents([local]);
		expect((await getUnsynced()).some((e) => e.id === local.id)).toBe(true);
	});
});
