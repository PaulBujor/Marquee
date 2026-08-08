import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, setActiveUser } from './db';
import {
	getLinkedMediaRefs,
	getMedia,
	getMediaVersions,
	getReferencedMediaIds,
	getUnsyncedMediaIds,
	pruneStaleMedia,
	putMedia,
	searchLocalMedia
} from './media';
import { applyEventToIdb, applyEventsToIdb } from './state';
import { createEvent, mediaId, tmdbMediaId, type MediaRecord } from '$lib/sync/events';

setActiveUser('media-search-test');

function record(over: Partial<MediaRecord> & Pick<MediaRecord, 'type' | 'title'>): MediaRecord {
	const externalId = over.externalId ?? `${over.type}/1`;
	return {
		id: over.id ?? tmdbMediaId(over.type, Number(externalId?.split('/')[1] ?? 1)),
		provider: 'tmdb',
		externalId,
		source: 'linked',
		year: null,
		posterPath: null,
		backdropPath: null,
		overview: '',
		genres: [],
		releaseDate: null,
		status: null,
		inProduction: null,
		firstAirDate: null,
		lastAirDate: null,
		version: 1,
		seasons: null,
		episodes: null,
		...over
	};
}

beforeEach(async () => {
	const db = await openDb();
	await db.clear('media');
});

describe('searchLocalMedia', () => {
	it('matches cached linked titles by case-insensitive substring, mapped to search results', async () => {
		await putMedia(
			record({ type: 'movie', externalId: 'movie/603', title: 'The Matrix', year: 1999 })
		);
		await putMedia(
			record({ type: 'show', externalId: 'show/1396', title: 'Breaking Bad', year: 2008 })
		);

		expect(await searchLocalMedia('matri')).toEqual([
			{
				tmdbId: 603,
				type: 'movie',
				title: 'The Matrix',
				year: 1999,
				posterPath: null,
				overview: ''
			}
		]);
	});

	it('excludes private custom entries (no external id)', async () => {
		await putMedia(record({ type: 'movie', externalId: 'movie/603', title: 'The Matrix' }));
		await putMedia(
			record({
				id: 'custom-1',
				type: 'movie',
				externalId: null,
				source: 'custom',
				title: 'Matrix home cut'
			})
		);
		expect((await searchLocalMedia('matrix')).map((r) => r.title)).toEqual(['The Matrix']);
	});

	it('sorts alphabetically and returns nothing for a blank query', async () => {
		await putMedia(record({ type: 'movie', externalId: 'movie/2', title: 'Zodiac' }));
		await putMedia(record({ type: 'movie', externalId: 'movie/3', title: 'Amelie' }));
		expect((await searchLocalMedia('i')).map((r) => r.title)).toEqual(['Amelie', 'Zodiac']);
		expect(await searchLocalMedia('  ')).toEqual([]);
	});
});

const DEVICE = '11111111-1111-1111-1111-111111111111';

async function track(externalId: string): Promise<void> {
	await applyEventToIdb(
		createEvent('tracking.added', mediaId('tmdb', externalId), { status: 'want_to_watch' }, DEVICE)
	);
}

describe('getReferencedMediaIds / getUnsyncedMediaIds / getLinkedMediaRefs / getMediaVersions', () => {
	beforeEach(async () => {
		const db = await openDb();
		await db.clear('tracking');
		await db.clear('episodeWatches');
		await db.clear('media');
	});

	it('collects ids from non-removed tracking rows and actively watched episodes', async () => {
		const trackedId = mediaId('tmdb', 'movie/1');
		await track('movie/1');
		const watchedOnlyId = mediaId('tmdb', 'show/2');
		const db = await openDb();
		await db.put('episodeWatches', {
			id: `${watchedOnlyId}::s1e1`,
			mediaId: watchedOnlyId,
			season: 1,
			episode: 1,
			watched: true,
			updatedAt: 1
		});

		const ids = await getReferencedMediaIds();
		expect(new Set(ids)).toEqual(new Set([trackedId, watchedOnlyId]));
	});

	it('excludes a removed (tombstoned) tracking row', async () => {
		const id = mediaId('tmdb', 'movie/5');
		await track('movie/5');
		await applyEventToIdb(createEvent('tracking.removed', id, {}, DEVICE));

		expect(await getReferencedMediaIds()).toEqual([]);
	});

	it('excludes an unwatched (tombstoned) episode row even with no tracking row at all', async () => {
		const id = mediaId('tmdb', 'show/6');
		const db = await openDb();
		await db.put('episodeWatches', {
			id: `${id}::s1e1`,
			mediaId: id,
			season: 1,
			episode: 1,
			watched: false,
			updatedAt: 1
		});

		expect(await getReferencedMediaIds()).toEqual([]);
	});

	it('stops referencing a title once removed, even though its watch history remains unwatched', async () => {
		const id = mediaId('tmdb', 'show/7');
		await track('show/7');
		await applyEventsToIdb([
			createEvent('episode.watched', id, { season: 1, episode: 1 }, DEVICE),
			createEvent('episode.unwatched', id, { season: 1, episode: 1 }, DEVICE),
			createEvent('tracking.removed', id, {}, DEVICE)
		]);

		expect(await getReferencedMediaIds()).toEqual([]);
	});

	it('flags a referenced id as unsynced when it has no local row or a version-0 placeholder', async () => {
		const noRow = mediaId('tmdb', 'movie/10');
		const placeholder = mediaId('tmdb', 'movie/11');
		const synced = mediaId('tmdb', 'movie/12');
		await track('movie/10');
		await track('movie/11');
		await track('movie/12');
		await putMedia(record({ id: placeholder, type: 'movie', title: 'p', version: 0 }));
		await putMedia(record({ id: synced, type: 'movie', title: 's', version: 1 }));

		const unsynced = await getUnsyncedMediaIds([noRow, placeholder, synced]);
		expect(new Set(unsynced)).toEqual(new Set([noRow, placeholder]));
	});

	it('scopes refs and versions to the requested ids only', async () => {
		const a = mediaId('tmdb', 'movie/20');
		const b = mediaId('tmdb', 'movie/21');
		await putMedia(record({ id: a, type: 'movie', title: 'a', externalId: 'movie/20' }));
		await putMedia(record({ id: b, type: 'movie', title: 'b', externalId: 'movie/21' }));

		expect(await getLinkedMediaRefs([a])).toEqual([{ provider: 'tmdb', externalId: 'movie/20' }]);
		expect(await getMediaVersions([a, b])).toEqual([
			{ id: a, version: 1 },
			{ id: b, version: 1 }
		]);
	});
});

function showRecord(id: string, externalId: string, title: string): MediaRecord {
	return record({
		id,
		type: 'show',
		title,
		externalId,
		seasons: [
			{
				seasonNumber: 1,
				name: 'Season 1',
				overview: '',
				airDate: null,
				posterPath: null,
				episodeCount: 1
			}
		],
		episodes: [
			{
				season: 1,
				episode: 1,
				name: 'Episode 1',
				overview: '',
				airDate: null,
				runtime: null,
				stillPath: null
			}
		]
	});
}

describe('pruneStaleMedia', () => {
	beforeEach(async () => {
		const db = await openDb();
		await db.clear('media');
		await db.clear('seasons');
		await db.clear('episodes');
	});

	it('deletes a media row and its seasons/episodes when outside the keep set', async () => {
		const kept = mediaId('tmdb', 'show/30');
		const dropped = mediaId('tmdb', 'show/31');
		await putMedia(showRecord(kept, 'show/30', 'Kept Show'));
		await putMedia(showRecord(dropped, 'show/31', 'Dropped Show'));

		const deleted = await pruneStaleMedia(new Set([kept]));

		expect(deleted).toBe(1);
		expect(await getMedia(dropped)).toBeUndefined();
		expect(await getMedia(kept)).toBeDefined();

		const db = await openDb();
		expect(await db.getAllFromIndex('seasons', 'by_media', dropped)).toEqual([]);
		expect(await db.getAllFromIndex('episodes', 'by_media', dropped)).toEqual([]);
		expect(await db.getAllFromIndex('seasons', 'by_media', kept)).toHaveLength(1);
		expect(await db.getAllFromIndex('episodes', 'by_media', kept)).toHaveLength(1);
	});

	it('keeps everything when nothing is outside the keep set', async () => {
		const id = mediaId('tmdb', 'movie/40');
		await putMedia(record({ id, type: 'movie', title: 'Keep', externalId: 'movie/40' }));

		expect(await pruneStaleMedia(new Set([id]))).toBe(0);
		expect(await getMedia(id)).toBeDefined();
	});

	it('is a no-op on an empty media store', async () => {
		expect(await pruneStaleMedia(new Set())).toBe(0);
	});
});

describe('removal-then-eviction', () => {
	beforeEach(async () => {
		const db = await openDb();
		await db.clear('tracking');
		await db.clear('episodeWatches');
		await db.clear('media');
		await db.clear('seasons');
		await db.clear('episodes');
	});

	it('stops caching a title once it is removed from every list', async () => {
		const kept = mediaId('tmdb', 'show/50');
		const removed = mediaId('tmdb', 'show/51');
		await track('show/50');
		await track('show/51');
		await putMedia(showRecord(kept, 'show/50', 'Kept Show'));
		await putMedia(showRecord(removed, 'show/51', 'Removed Show'));

		// Both still on a list — nothing evicted yet.
		let keepIds = new Set(await getReferencedMediaIds());
		expect(keepIds).toEqual(new Set([kept, removed]));
		expect(await pruneStaleMedia(keepIds)).toBe(0);

		// Remove one title the way `TrackingState.remove()` does: unwatch, then tombstone tracking.
		await applyEventsToIdb([
			createEvent('episode.unwatched', removed, { season: 1, episode: 1 }, DEVICE),
			createEvent('tracking.removed', removed, {}, DEVICE)
		]);

		keepIds = new Set(await getReferencedMediaIds());
		expect(keepIds).toEqual(new Set([kept]));

		const deleted = await pruneStaleMedia(keepIds);
		expect(deleted).toBe(1);
		expect(await getMedia(removed)).toBeUndefined();
		const db = await openDb();
		expect(await db.getAllFromIndex('seasons', 'by_media', removed)).toEqual([]);
		expect(await db.getAllFromIndex('episodes', 'by_media', removed)).toEqual([]);

		// The still-tracked title, and the tracking/episodeWatches rows themselves, are untouched.
		expect(await getMedia(kept)).toBeDefined();
		expect((await db.getAllFromIndex('seasons', 'by_media', kept)).length).toBe(1);
		expect(await db.get('tracking', removed)).toMatchObject({ removed: true });
	});
});
