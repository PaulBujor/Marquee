import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	tmdbMediaId,
	type EventEnvelope,
	type EventPayloadMap,
	type SyncEventType
} from '$lib/sync/events';
import { openDb, setActiveUser } from './db';
import { applyEventToIdb, getEpisodeWatches, getTracking, getTrackingByMediaId } from './state';

setActiveUser('test-user'); // the store is namespaced per user; scope it before opening

const DEVICE = '11111111-1111-1111-1111-111111111111';

// Distinct mediaId per test — fake-indexeddb persists across a file's tests, so
// isolating by key avoids cross-test interference without resetting the singleton.
let midCounter = 0;
function newMid(): string {
	midCounter += 1;
	return tmdbMediaId('movie', midCounter);
}

let uuidCounter = 0;
function nextUuid(): string {
	uuidCounter += 1;
	return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
}

function ev<T extends SyncEventType>(
	type: T,
	entityId: string,
	payload: EventPayloadMap[T],
	clock: number
): EventEnvelope<T> {
	return {
		id: nextUuid(),
		type,
		entityId,
		payload,
		deviceId: DEVICE,
		clientCreatedAt: clock,
		schemaVersion: 1
	};
}

async function trackingRow(mid: string) {
	const db = await openDb();
	return db.get('tracking', mid);
}

describe('applyEventToIdb', () => {
	let MID: string;
	beforeEach(() => {
		MID = newMid();
	});

	it('materializes tracking from an add', async () => {
		await applyEventToIdb(ev('tracking.added', MID, { status: 'watching' }, 100));
		const tracked = await getTracking();
		expect(tracked.find((t) => t.mediaId === MID)).toMatchObject({
			status: 'watching',
			removed: false
		});
	});

	it('reads a single title by media id, including a removed tombstone', async () => {
		expect(await getTrackingByMediaId(MID)).toBeUndefined();
		await applyEventToIdb(ev('tracking.added', MID, { status: 'want_to_watch' }, 100));
		expect(await getTrackingByMediaId(MID)).toMatchObject({
			status: 'want_to_watch',
			removed: false
		});
		await applyEventToIdb(ev('tracking.removed', MID, {}, 200));
		// getTracking() hides it, but the by-id read still returns the tombstone.
		expect((await getTracking()).find((t) => t.mediaId === MID)).toBeUndefined();
		expect(await getTrackingByMediaId(MID)).toMatchObject({ removed: true });
	});

	it('resolves status by last-write-wins regardless of arrival order', async () => {
		await applyEventToIdb(ev('tracking.status_changed', MID, { status: 'completed' }, 200));
		await applyEventToIdb(ev('tracking.status_changed', MID, { status: 'watching' }, 100));
		expect((await trackingRow(MID))?.status).toBe('completed');
	});

	it('keeps favorite independent of status (per-field clocks)', async () => {
		await applyEventToIdb(ev('tracking.status_changed', MID, { status: 'completed' }, 500));
		await applyEventToIdb(ev('tracking.favorite_toggled', MID, { favorite: true }, 100));
		const row = await trackingRow(MID);
		expect(row?.status).toBe('completed');
		expect(row?.favorite).toBe(true);
	});

	it('applies a rating and clears it by LWW', async () => {
		await applyEventToIdb(ev('tracking.rated', MID, { rating: 5 }, 100));
		expect((await trackingRow(MID))?.rating).toBe(5);
		await applyEventToIdb(ev('tracking.rated', MID, { rating: null }, 200));
		expect((await trackingRow(MID))?.rating).toBeNull();
	});

	it('applies episode watched/unwatched by LWW', async () => {
		await applyEventToIdb(ev('episode.watched', MID, { season: 1, episode: 1 }, 200));
		await applyEventToIdb(ev('episode.unwatched', MID, { season: 1, episode: 1 }, 100));
		expect((await getEpisodeWatches(MID))[0].watched).toBe(true); // older unwatch loses
		await applyEventToIdb(ev('episode.unwatched', MID, { season: 1, episode: 1 }, 300));
		expect((await getEpisodeWatches(MID))[0].watched).toBe(false); // newer unwatch wins
	});

	it('clears episode watches on removal and a stale watch cannot resurrect them', async () => {
		// remove() emits an unwatch per watched episode (newer clock) then the tombstone.
		await applyEventToIdb(ev('episode.watched', MID, { season: 1, episode: 2 }, 100));
		await applyEventToIdb(ev('episode.unwatched', MID, { season: 1, episode: 2 }, 200));
		await applyEventToIdb(ev('tracking.removed', MID, {}, 200));
		expect((await getEpisodeWatches(MID))[0].watched).toBe(false);
		// A late-arriving copy of the original watch (older clock) must not revive progress.
		await applyEventToIdb(ev('episode.watched', MID, { season: 1, episode: 2 }, 100));
		expect((await getEpisodeWatches(MID))[0].watched).toBe(false);
	});

	it('does not undo a newer removal with an older re-add (revive fix mirror)', async () => {
		await applyEventToIdb(ev('tracking.added', MID, { status: 'watching' }, 100));
		await applyEventToIdb(ev('tracking.removed', MID, {}, 300));
		await applyEventToIdb(ev('tracking.added', MID, { status: 'watching' }, 200));
		expect((await trackingRow(MID))?.removed).toBe(true); // removal@300 still wins
	});
});
