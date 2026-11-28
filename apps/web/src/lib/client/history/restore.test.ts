import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
	createEvent,
	type EventPayloadMap,
	type EventEnvelope,
	type SyncEventType
} from '#lib/sync/events.js';
import { diffStates, stateAt } from '#lib/sync/history.js';
import { setActiveUser } from '#lib/client/idb/db.js';
import { getUnsynced } from '#lib/client/idb/outbox.js';
import { getTracking } from '#lib/client/idb/state.js';
import { restoreTitles } from './restore';

setActiveUser('restore-test-user');

function ev<T extends SyncEventType>(
	type: T,
	entityId: string,
	payload: EventPayloadMap[T],
	clock: number
): EventEnvelope<T> {
	return createEvent(type, entityId, payload, 'device', clock);
}

describe('restoreTitles', () => {
	it('writes the compensating events to the outbox and applies them locally', async () => {
		const events = [
			ev('tracking.added', 'movie/a', { status: 'watching' }, 1000),
			ev('tracking.removed', 'movie/a', {}, 2000)
		];
		const written = await restoreTitles(diffStates(stateAt(events, 3000), stateAt(events, 1000)));

		expect(written).toBe(1);
		expect((await getUnsynced()).map((e) => e.type)).toEqual(['tracking.added']);
		const row = (await getTracking()).find((t) => t.mediaId === 'movie/a');
		expect(row?.removed).toBe(false);
		expect(row?.status).toBe('watching');
	});

	it('writes nothing for an unchanged library', async () => {
		expect(await restoreTitles(diffStates(stateAt([], 0), stateAt([], 0)))).toBe(0);
	});
});
