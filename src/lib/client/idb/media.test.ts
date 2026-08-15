import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, setActiveUser } from './db';
import {
	clearPendingPush,
	getCredits,
	getCreditsForPerson,
	getLinkedMediaRefs,
	getMedia,
	getMediaVersions,
	getPendingCustomMedia,
	getReferencedMediaIds,
	getUnsyncedMediaIds,
	pruneStaleMedia,
	putCustomMedia,
	putMedia,
	putMediaBatch,
	searchCustomMedia,
	searchLocalMedia
} from './media';
import { applyEventToIdb, applyEventsToIdb } from './state';
import {
	createEvent,
	mediaId,
	tmdbMediaId,
	type MediaCredit,
	type MediaRecord
} from '$lib/sync/events';

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
		credits: null,
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

describe('searchCustomMedia', () => {
	const CUSTOM_ID = '77777777-7777-4777-8777-777777777777';

	beforeEach(async () => {
		const db = await openDb();
		await db.clear('media');
		await db.clear('mediaLinks');
		await putCustomMedia(
			record({
				id: CUSTOM_ID,
				provider: 'local',
				externalId: null,
				source: 'custom',
				type: 'movie',
				title: 'Midnight Cassette Club',
				version: 0
			})
		);
	});

	it('finds the user’s own entries, which nothing upstream could return', async () => {
		expect((await searchCustomMedia('cassette')).map((m) => m.id)).toEqual([CUSTOM_ID]);
	});

	it('drops an entry once it has been matched to a real title', async () => {
		// Offering it beside the title it now *is* would invite adding the same work twice.
		await applyEventToIdb(
			createEvent(
				'media.linked',
				CUSTOM_ID,
				{
					targetId: tmdbMediaId('movie', 603),
					provider: 'tmdb',
					externalId: 'movie/603'
				},
				DEVICE
			)
		);
		expect(await searchCustomMedia('cassette')).toEqual([]);
	});

	it('brings the entry back once the match is taken back', async () => {
		// The round trip the unlink control exists for: nothing about linking was destructive, so
		// undoing it has to restore the only route back to the entry.
		const link = createEvent(
			'media.linked',
			CUSTOM_ID,
			{ targetId: tmdbMediaId('movie', 603), provider: 'tmdb', externalId: 'movie/603' },
			DEVICE
		);
		await applyEventToIdb(link);
		expect(await searchCustomMedia('cassette')).toEqual([]);

		await applyEventToIdb({
			...createEvent('media.unlinked', CUSTOM_ID, {}, DEVICE),
			clientCreatedAt: link.clientCreatedAt + 1
		});
		expect((await searchCustomMedia('cassette')).map((m) => m.id)).toEqual([CUSTOM_ID]);
	});

	it('keeps an entry whose suggestions were merely dismissed', async () => {
		// Declining a match says "not this one", not "this is that" — the entry is still the only way
		// to reach the title.
		await applyEventToIdb(createEvent('media.match_declined', CUSTOM_ID, {}, DEVICE));
		expect((await searchCustomMedia('cassette')).map((m) => m.id)).toEqual([CUSTOM_ID]);
	});
});

describe('credits', () => {
	const ID = mediaId('tmdb', 'movie/50');

	function credit(over: Partial<MediaCredit> & Pick<MediaCredit, 'personId'>): MediaCredit {
		return {
			externalId: `person/${over.personId}`,
			name: `Person ${over.personId}`,
			profilePath: null,
			role: 'cast',
			character: null,
			sortOrder: 0,
			...over
		};
	}

	beforeEach(async () => {
		const db = await openDb();
		await db.clear('media');
		await db.clear('credits');
	});

	it('round-trips a cast and crew list, ordered by role then billing', async () => {
		await putMedia(
			record({
				id: ID,
				type: 'movie',
				title: 'Credited',
				externalId: 'movie/50',
				credits: [
					credit({ personId: '2', name: 'Second Billed', sortOrder: 1, character: 'Trinity' }),
					credit({ personId: '1', name: 'Top Billed', sortOrder: 0, character: 'Neo' }),
					credit({ personId: '3', name: 'A Director', role: 'director' })
				]
			})
		);

		// Roles group first, each keeping its billing — the same order the server hands them over in,
		// so a renderer can section without re-sorting and two devices always agree.
		const rows = await getCredits(ID);
		expect(rows.map((c) => c.name)).toEqual(['Top Billed', 'Second Billed', 'A Director']);
		expect(rows[0]).toMatchObject({
			personId: '1',
			externalId: 'person/1',
			character: 'Neo',
			mediaId: ID
		});
	});

	it('serves the reverse lookup — every title a person is credited on', async () => {
		const other = mediaId('tmdb', 'movie/51');
		await putMedia(
			record({ id: ID, type: 'movie', title: 'One', credits: [credit({ personId: '7' })] })
		);
		await putMedia(
			record({
				id: other,
				type: 'movie',
				title: 'Two',
				externalId: 'movie/51',
				credits: [credit({ personId: '7' }), credit({ personId: '8' })]
			})
		);

		expect((await getCreditsForPerson('7')).map((c) => c.mediaId).sort()).toEqual(
			[ID, other].sort()
		);
		expect(await getCreditsForPerson('8')).toHaveLength(1);
	});

	it('replaces the stored list on a fresh pull, dropping a credit that disappeared', async () => {
		const full = record({
			id: ID,
			type: 'movie',
			title: 'Recredited',
			externalId: 'movie/50',
			credits: [credit({ personId: '1' }), credit({ personId: '2' })]
		});
		await putMedia(full);
		await putMedia({ ...full, credits: [credit({ personId: '1' })] });

		expect((await getCredits(ID)).map((c) => c.personId)).toEqual(['1']);
	});

	it('leaves a stored list alone for a scalar-only snapshot, and clears it for a known-empty one', async () => {
		const base = record({
			id: ID,
			type: 'movie',
			title: 'Snapshot',
			externalId: 'movie/50',
			credits: [credit({ personId: '1' })]
		});
		await putMedia(base);

		// null = "unknown" — a quick-add snapshot must not blank a synced cast.
		await putMedia({ ...base, credits: null });
		expect(await getCredits(ID)).toHaveLength(1);

		// [] = "known to have none" — an upstream correction that really did empty the list.
		await putMedia({ ...base, credits: [] });
		expect(await getCredits(ID)).toEqual([]);
	});

	it('is written by a batch pull the same way, and evicted with its title', async () => {
		await putMediaBatch([
			record({
				id: ID,
				type: 'movie',
				title: 'Batched',
				externalId: 'movie/50',
				credits: [credit({ personId: '1' })]
			})
		]);
		expect(await getCredits(ID)).toHaveLength(1);

		await pruneStaleMedia(new Set());
		expect(await getCredits(ID)).toEqual([]);
	});
});

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

describe('custom media backup', () => {
	const CUSTOM_ID = '44444444-4444-4444-8444-444444444444';

	function customRecord(over: Partial<MediaRecord> = {}): MediaRecord {
		return record({
			id: CUSTOM_ID,
			provider: 'local',
			externalId: null,
			source: 'custom',
			type: 'movie',
			title: 'Midnight Cassette Club',
			version: 0,
			...over
		});
	}

	beforeEach(async () => {
		const db = await openDb();
		await db.clear('media');
	});

	it('queues a newly authored record with its edit clock', async () => {
		await putCustomMedia(customRecord(), 5000);
		const pending = await getPendingCustomMedia(10);
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ id: CUSTOM_ID, source: 'custom', editedAt: 5000 });
		// The push carries the wire shape, not the local composite keys the child stores add.
		expect(pending[0].seasons).toBeNull();
	});

	it('carries a show as its seasons and episodes, without the local key columns', async () => {
		await putCustomMedia(
			customRecord({
				type: 'show',
				seasons: [
					{
						seasonNumber: 1,
						name: 'Season 1',
						overview: '',
						airDate: '1986-01-01',
						posterPath: null,
						episodeCount: 1
					}
				],
				episodes: [
					{
						season: 1,
						episode: 1,
						name: '',
						overview: '',
						airDate: '1986-01-01',
						runtime: null,
						stillPath: null
					}
				]
			}),
			5000
		);
		const [pushed] = await getPendingCustomMedia(10);
		expect(pushed.seasons).toEqual([
			{
				seasonNumber: 1,
				name: 'Season 1',
				overview: '',
				airDate: '1986-01-01',
				posterPath: null,
				episodeCount: 1
			}
		]);
		expect(pushed.episodes?.[0]).not.toHaveProperty('mediaId');
	});

	it('drains oldest edit first', async () => {
		const second = '55555555-5555-4555-8555-555555555555';
		await putCustomMedia(customRecord({ id: second, title: 'Later' }), 9000);
		await putCustomMedia(customRecord({ title: 'Earlier' }), 1000);
		expect((await getPendingCustomMedia(10)).map((r) => r.title)).toEqual(['Earlier', 'Later']);
	});

	it('stops queueing a record once the server reports it stored', async () => {
		await putCustomMedia(customRecord(), 5000);
		await clearPendingPush([CUSTOM_ID]);
		expect(await getPendingCustomMedia(10)).toEqual([]);
	});

	it('lets a second local edit overwrite one that has not been pushed yet', async () => {
		await putCustomMedia(customRecord({ title: 'First draft' }), 5000);
		await putCustomMedia(customRecord({ title: 'Corrected' }), 6000);
		const pending = await getPendingCustomMedia(10);
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ title: 'Corrected', editedAt: 6000 });
	});

	it('refuses to let a server copy clobber an edit still waiting to be pushed', async () => {
		await putCustomMedia(customRecord({ title: 'Just typed' }), 6000);
		// The response to an *earlier* push arrives carrying the pre-edit copy.
		await putMedia(customRecord({ title: 'Stale server copy', version: 1 }));
		expect((await getMedia(CUSTOM_ID))?.title).toBe('Just typed');
	});

	it('applies a server copy once nothing is queued for it', async () => {
		await putCustomMedia(customRecord({ title: 'Mine' }), 6000);
		await clearPendingPush([CUSTOM_ID]);
		await putMedia(customRecord({ title: 'From another device', version: 2 }));
		expect(await getMedia(CUSTOM_ID)).toMatchObject({
			title: 'From another device',
			version: 2
		});
	});

	it('never asks the pull side about a custom title — nothing upstream has one', async () => {
		await putCustomMedia(customRecord(), 5000);
		// It sits at version 0, which for a provider-backed row means "ask the server about this".
		expect(await getUnsyncedMediaIds([CUSTOM_ID])).toEqual([]);
	});

	it('is never evicted, even once it has left every list', async () => {
		await putCustomMedia(customRecord(), 5000);
		// The only copy of a user-authored entry; nothing could re-fetch it.
		expect(await pruneStaleMedia(new Set())).toBe(0);
		expect(await getMedia(CUSTOM_ID)).toBeDefined();
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
