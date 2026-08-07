import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, setActiveUser } from './db';
import {
	getLinkedMediaRefs,
	getMediaVersions,
	getReferencedMediaIds,
	getUnsyncedMediaIds,
	putMedia,
	searchLocalMedia
} from './media';
import { applyEventToIdb } from './state';
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

	it('includes season count (excluding Specials) and inProduction for shows, not movies', async () => {
		await putMedia(
			record({
				type: 'show',
				externalId: 'show/999',
				title: 'Better Call Saul',
				inProduction: false,
				seasons: [
					{
						seasonNumber: 0,
						name: 'Specials',
						overview: '',
						airDate: null,
						posterPath: null,
						episodeCount: 1
					},
					{
						seasonNumber: 1,
						name: 'Season 1',
						overview: '',
						airDate: null,
						posterPath: null,
						episodeCount: 10
					},
					{
						seasonNumber: 2,
						name: 'Season 2',
						overview: '',
						airDate: null,
						posterPath: null,
						episodeCount: 10
					}
				]
			})
		);
		await putMedia(record({ type: 'movie', externalId: 'movie/603', title: 'The Matrix' }));

		const [show] = await searchLocalMedia('better call saul');
		expect(show).toMatchObject({ numberOfSeasons: 2, inProduction: false });

		const [movie] = await searchLocalMedia('the matrix');
		expect(movie.numberOfSeasons).toBeUndefined();
		expect(movie.inProduction).toBeUndefined();
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

	it('collects referenced ids from tracking (unconditionally) and episode watches', async () => {
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
