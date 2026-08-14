import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { setActiveUser } from '$lib/client/idb/db';
import { putMedia, type ClientEpisode } from '$lib/client/idb';
import { personExternalId, personId, tmdbMediaId, type MediaRecord } from '$lib/sync/events';
import { buildOfflineDetail, offlineSeason } from './offline-detail';

setActiveUser('offline-detail-test'); // namespace the store before opening

function episode(season: number, ep: number, extra: Partial<ClientEpisode> = {}): ClientEpisode {
	return {
		id: `m::s${season}e${ep}`,
		mediaId: 'm',
		season,
		episode: ep,
		name: `E${ep}`,
		overview: '',
		airDate: null,
		runtime: null,
		stillPath: null,
		...extra
	};
}

describe('offlineSeason', () => {
	it('maps and orders one season’s cached episodes, dropping other seasons', () => {
		const rows = [
			episode(1, 2, { name: 'B', overview: 'o2', airDate: '2020-01-08', runtime: 42 }),
			episode(1, 1, { name: 'A', overview: 'o1', airDate: '2020-01-01', stillPath: '/s.jpg' }),
			episode(2, 1, { name: 'other' })
		];
		expect(offlineSeason(1, 'Season 1', 'A season synopsis.', rows)).toEqual({
			seasonNumber: 1,
			name: 'Season 1',
			overview: 'A season synopsis.',
			episodes: [
				{
					episodeNumber: 1,
					name: 'A',
					airDate: '2020-01-01',
					overview: 'o1',
					stillPath: '/s.jpg',
					runtime: null
				},
				{
					episodeNumber: 2,
					name: 'B',
					airDate: '2020-01-08',
					overview: 'o2',
					stillPath: null,
					runtime: 42
				}
			]
		});
	});
});

const movie: MediaRecord = {
	id: tmdbMediaId('movie', 603),
	provider: 'tmdb',
	externalId: 'movie/603',
	source: 'linked',
	type: 'movie',
	title: 'The Matrix',
	year: 1999,
	posterPath: '/p.jpg',
	backdropPath: '/b.jpg',
	overview: 'Neo.',
	genres: ['Action'],
	releaseDate: '1999-03-31',
	status: null,
	inProduction: null,
	firstAirDate: null,
	lastAirDate: null,
	version: 1,
	seasons: null,
	episodes: null,
	credits: [
		{
			personId: personId('tmdb', 6384),
			externalId: personExternalId(6384),
			name: 'Keanu Reeves',
			profilePath: '/keanu.jpg',
			role: 'cast',
			character: 'Neo',
			sortOrder: 0
		},
		{
			personId: personId('tmdb', 9339),
			externalId: personExternalId(9339),
			name: 'Lana Wachowski',
			profilePath: null,
			role: 'director',
			character: null,
			sortOrder: 0
		},
		{
			// Minted locally (a user-typed name), so there's no person page to link to.
			personId: '99999999-9999-4999-8999-999999999999',
			externalId: null,
			name: 'Uncredited Gaffer',
			profilePath: null,
			role: 'producer',
			character: null,
			sortOrder: 0
		}
	]
};

describe('buildOfflineDetail', () => {
	it('returns null for an uncached title', async () => {
		expect(await buildOfflineDetail('movie', 424242)).toBeNull();
	});

	it('rebuilds a degraded movie detail from the cache (TMDB-only fields nulled)', async () => {
		await putMedia(movie);
		const out = await buildOfflineDetail('movie', 603);
		expect(out).not.toBeNull();
		expect(out?.detail).toMatchObject({
			tmdbId: 603,
			type: 'movie',
			title: 'The Matrix',
			genres: ['Action'],
			releaseDate: '1999-03-31',
			rating: null,
			runtime: null,
			trailer: null,
			similar: []
		});
		expect(out?.season).toBeNull();
	});

	it('rebuilds cast and crew from the cached credits, addressed by TMDB person id', async () => {
		await putMedia(movie);
		const detail = (await buildOfflineDetail('movie', 603))?.detail;
		expect(detail?.cast).toEqual([
			{ id: 6384, name: 'Keanu Reeves', character: 'Neo', profilePath: '/keanu.jpg' }
		]);
		expect(detail?.director).toEqual({ id: 9339, name: 'Lana Wachowski' });
		// A locally-minted person has no provider id, so there is no page to link them to.
		expect(detail?.producers).toEqual([]);
	});

	it('rebuilds a show with its selected season episodes', async () => {
		await putMedia({
			id: tmdbMediaId('show', 1396),
			provider: 'tmdb',
			externalId: 'show/1396',
			source: 'linked',
			type: 'show',
			title: 'Breaking Bad',
			year: 2008,
			posterPath: null,
			backdropPath: null,
			overview: '',
			genres: [],
			releaseDate: null,
			status: 'Ended',
			inProduction: false,
			firstAirDate: '2008-01-20',
			lastAirDate: '2013-09-29',
			version: 1,
			seasons: [
				{
					seasonNumber: 1,
					name: 'Season 1',
					overview: 'A season synopsis.',
					airDate: '2008-01-20',
					posterPath: null,
					episodeCount: 2
				}
			],
			episodes: [
				{
					season: 1,
					episode: 1,
					name: 'Pilot',
					overview: '',
					airDate: '2008-01-20',
					runtime: 58,
					stillPath: null
				},
				{
					season: 1,
					episode: 2,
					name: 'Cat',
					overview: '',
					airDate: '2008-01-27',
					runtime: 48,
					stillPath: null
				}
			],
			credits: []
		});
		const out = await buildOfflineDetail('show', 1396);
		expect(out?.detail.seasons).toHaveLength(1);
		expect(out?.detail.seasons[0]?.overview).toBe('A season synopsis.');
		expect(out?.season?.seasonNumber).toBe(1);
		expect(out?.season?.overview).toBe('A season synopsis.');
		expect(out?.season?.episodes.map((e) => e.name)).toEqual(['Pilot', 'Cat']);
	});
});
