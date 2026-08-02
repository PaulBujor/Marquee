import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { setActiveUser } from '$lib/client/idb/db';
import { applyEventToIdb } from '$lib/client/idb/state';
import { putMedia } from '$lib/client/idb/media';
import {
	tmdbExternalId,
	tmdbMediaId,
	type EventEnvelope,
	type SyncEventType
} from '$lib/sync/events';
import { mediaRecordFromSearch } from '$lib/tracking/media-record';
import { collectExport, exportFilename } from './export';

setActiveUser('export-test-user');

const DEVICE = '11111111-1111-1111-1111-111111111111';

let uuidCounter = 0;
function ev<T extends SyncEventType>(
	type: T,
	entityId: string,
	payload: EventEnvelope<T>['payload'],
	clock: number
): EventEnvelope<T> {
	uuidCounter += 1;
	return {
		id: `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`,
		type,
		entityId,
		payload,
		deviceId: DEVICE,
		clientCreatedAt: clock,
		schemaVersion: 1
	};
}

describe('exportFilename', () => {
	it('dates the file so repeated exports do not overwrite each other', () => {
		expect(exportFilename(new Date('2026-08-01T14:22:03.451Z'))).toBe(
			'marquee-export-2026-08-01.json'
		);
	});

	// Either side of local midnight the UTC date differs from the user's, in opposite directions
	// depending on the sign of the offset. Asserting both means this holds in any timezone — and
	// catches a UTC-based implementation wherever the runner happens to sit.
	it('uses the calendar date the user sees late at night, not UTC', () => {
		expect(exportFilename(new Date(2026, 7, 1, 23, 30, 0))).toBe('marquee-export-2026-08-01.json');
	});

	it('uses the calendar date the user sees just after midnight, not UTC', () => {
		expect(exportFilename(new Date(2026, 7, 2, 0, 30, 0))).toBe('marquee-export-2026-08-02.json');
	});
});

describe('collectExport', () => {
	it('reads tracking, media and episode watches out of the local replica', async () => {
		const showId = tmdbMediaId('show', 95396);
		await putMedia({
			...mediaRecordFromSearch({
				tmdbId: 95396,
				type: 'show',
				title: 'Severance',
				year: 2022,
				posterPath: null
			}),
			externalId: tmdbExternalId('show', 95396)
		});
		await applyEventToIdb(ev('tracking.added', showId, { status: 'watching' }, 1000));
		await applyEventToIdb(ev('tracking.rated', showId, { rating: 4 }, 1500));
		await applyEventToIdb(ev('episode.watched', showId, { season: 1, episode: 1 }, 2000));

		const doc = await collectExport(new Date('2026-08-01T14:22:03.451Z'));
		const entry = doc.titles.find((t) => t.mediaId === showId);

		expect(entry).toMatchObject({
			title: 'Severance',
			externalId: 'show/95396',
			status: 'watching',
			rating: 4
		});
		expect(entry?.watchedEpisodes).toEqual([
			{ season: 1, episode: 1, watchedAt: new Date(2000).toISOString() }
		]);
	});

	it('omits a title the user removed', async () => {
		const goneId = tmdbMediaId('movie', 111);
		await applyEventToIdb(ev('tracking.added', goneId, { status: 'want_to_watch' }, 1000));
		await applyEventToIdb(ev('tracking.removed', goneId, {}, 2000));

		const doc = await collectExport(new Date('2026-08-01T14:22:03.451Z'));

		expect(doc.titles.some((t) => t.mediaId === goneId)).toBe(false);
	});
});
