import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, setActiveUser } from './db';
import { putMedia, searchLocalMedia } from './media';
import { tmdbMediaId, type MediaRecord } from '$lib/sync/events';

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
