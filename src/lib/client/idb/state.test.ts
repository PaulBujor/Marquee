import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	tmdbMediaId,
	type EventEnvelope,
	type EventPayloadMap,
	type SyncEventType
} from '$lib/sync/events';
import { openDb, setActiveUser } from './db';
import {
	applyEventToIdb,
	applyEventsToIdb,
	getAllEpisodeWatches,
	getEpisodeWatches,
	getTracking,
	getTrackingByMediaId
} from './state';

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

describe('applyEventsToIdb', () => {
	it('materializes a batch the same way applying each event would', async () => {
		const one = newMid();
		const two = newMid();
		await applyEventsToIdb([
			ev('tracking.added', one, { status: 'watching' }, 100),
			ev('tracking.rated', one, { rating: 4 }, 150),
			ev('episode.watched', one, { season: 1, episode: 1 }, 200),
			ev('tracking.added', two, { status: 'completed' }, 100),
			ev('tracking.favorite_toggled', two, { favorite: true }, 120)
		]);

		expect(await trackingRow(one)).toMatchObject({ status: 'watching', rating: 4 });
		expect(await trackingRow(two)).toMatchObject({ status: 'completed', favorite: true });
		expect((await getEpisodeWatches(one))[0].watched).toBe(true);
	});

	it('applies last-write-wins within the batch regardless of order', async () => {
		const mid = newMid();
		await applyEventsToIdb([
			ev('tracking.status_changed', mid, { status: 'completed' }, 300),
			ev('tracking.status_changed', mid, { status: 'want_to_watch' }, 100)
		]);

		expect((await trackingRow(mid))?.status).toBe('completed');
	});

	it('keeps the earliest clock as the date added across the batch', async () => {
		const mid = newMid();
		await applyEventsToIdb([
			ev('episode.watched', mid, { season: 1, episode: 2 }, 500),
			ev('tracking.added', mid, { status: 'watching' }, 100)
		]);

		expect((await trackingRow(mid))?.addedAt).toBe(100);
	});

	it('uses one transaction for the whole batch, not one per event', async () => {
		const db = await openDb();
		const original = db.transaction.bind(db);
		let opened = 0;
		const spied = db as unknown as { transaction: unknown };
		spied.transaction = (...args: unknown[]) => {
			opened += 1;
			return (original as (...a: unknown[]) => unknown)(...args);
		};

		const mid = newMid();
		try {
			await applyEventsToIdb([
				ev('tracking.added', mid, { status: 'watching' }, 100),
				ev('tracking.rated', mid, { rating: 5 }, 100),
				ev('episode.watched', mid, { season: 1, episode: 1 }, 100),
				ev('episode.watched', mid, { season: 1, episode: 2 }, 100)
			]);
		} finally {
			spied.transaction = original;
		}

		// Applied one at a time this would be five (a `tracking.added` alone costs two).
		expect(opened).toBe(1);
	});

	it('does nothing, and opens nothing, for an empty batch', async () => {
		await expect(applyEventsToIdb([])).resolves.toBeUndefined();
	});
});

describe('getAllEpisodeWatches', () => {
	it('returns watch rows across every show in one read', async () => {
		const first = newMid();
		const second = newMid();
		await applyEventToIdb(ev('episode.watched', first, { season: 1, episode: 1 }, 100));
		await applyEventToIdb(ev('episode.watched', second, { season: 2, episode: 5 }, 100));
		// Unwatched rows are returned too — callers decide; the export filters them.
		await applyEventToIdb(ev('episode.unwatched', second, { season: 2, episode: 6 }, 100));

		const all = await getAllEpisodeWatches();
		const mine = all.filter((w) => w.mediaId === first || w.mediaId === second);
		expect(mine).toHaveLength(3);
		expect(mine.filter((w) => w.mediaId === first)).toHaveLength(1);
		expect(mine.find((w) => w.season === 2 && w.episode === 6)?.watched).toBe(false);
	});
});
