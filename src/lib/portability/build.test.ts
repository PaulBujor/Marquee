import { describe, expect, it } from 'vitest';
import type { ClientEpisodeWatch, ClientMedia, ClientTracking } from '$lib/client/idb';
import { tmdbExternalId, tmdbMediaId } from '$lib/sync/events';
import { buildExport } from './build';
import { EXPORT_FORMAT, EXPORT_SCHEMA_VERSION } from './schema';

const EXPORTED_AT = new Date('2026-08-01T14:22:03.451Z');
const ADDED_AT = Date.UTC(2026, 2, 11, 9, 4, 0);

const SEVERANCE = tmdbMediaId('show', 95396);
const INCEPTION = tmdbMediaId('movie', 27205);

function tracking(overrides: Partial<ClientTracking> & { mediaId: string }): ClientTracking {
	return {
		status: 'want_to_watch',
		favorite: false,
		rating: null,
		removed: false,
		statusUpdatedAt: ADDED_AT,
		favoriteUpdatedAt: ADDED_AT,
		ratingUpdatedAt: ADDED_AT,
		removedUpdatedAt: 0,
		addedAt: ADDED_AT,
		...overrides
	};
}

function media(overrides: Partial<ClientMedia> & { id: string }): ClientMedia {
	return {
		provider: 'tmdb',
		externalId: null,
		source: 'linked',
		type: 'movie',
		title: 'Untitled',
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
		version: 3,
		updatedAt: ADDED_AT,
		...overrides
	};
}

function watch(
	mediaId: string,
	season: number,
	episode: number,
	watched = true
): ClientEpisodeWatch {
	return {
		id: `${mediaId}::s${season}e${episode}`,
		mediaId,
		season,
		episode,
		watched,
		updatedAt: ADDED_AT
	};
}

describe('buildExport', () => {
	it('stamps the format discriminator, schema version and export instant', () => {
		const doc = buildExport({ tracking: [], media: [], watches: [], exportedAt: EXPORTED_AT });

		expect(doc.format).toBe(EXPORT_FORMAT);
		expect(doc.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
		expect(doc.exportedAt).toBe('2026-08-01T14:22:03.451Z');
		expect(doc.titles).toEqual([]);
		expect(doc.titleCount).toBe(0);
	});

	it('exports a movie with its tracking state and no episodes', () => {
		const doc = buildExport({
			tracking: [tracking({ mediaId: INCEPTION, status: 'completed', rating: 5, favorite: true })],
			media: [
				media({
					id: INCEPTION,
					externalId: tmdbExternalId('movie', 27205),
					type: 'movie',
					title: 'Inception',
					year: 2010
				})
			],
			watches: [],
			exportedAt: EXPORTED_AT
		});

		expect(doc.titles).toEqual([
			{
				mediaId: INCEPTION,
				provider: 'tmdb',
				externalId: 'movie/27205',
				type: 'movie',
				title: 'Inception',
				year: 2010,
				status: 'completed',
				favorite: true,
				rating: 5,
				addedAt: new Date(ADDED_AT).toISOString(),
				watchedEpisodes: []
			}
		]);
	});

	it('attaches only watched episodes to their show', () => {
		const doc = buildExport({
			tracking: [tracking({ mediaId: SEVERANCE, status: 'watching' })],
			media: [media({ id: SEVERANCE, type: 'show', title: 'Severance' })],
			watches: [
				watch(SEVERANCE, 1, 1),
				watch(SEVERANCE, 1, 2, false),
				watch(SEVERANCE, 1, 3),
				watch('some-other-show', 4, 1)
			],
			exportedAt: EXPORTED_AT
		});

		expect(doc.titles[0].watchedEpisodes).toEqual([
			{ season: 1, episode: 1 },
			{ season: 1, episode: 3 }
		]);
	});

	it('orders watched episodes by season then episode', () => {
		const doc = buildExport({
			tracking: [tracking({ mediaId: SEVERANCE })],
			media: [media({ id: SEVERANCE, type: 'show', title: 'Severance' })],
			watches: [
				watch(SEVERANCE, 2, 1),
				watch(SEVERANCE, 1, 10),
				watch(SEVERANCE, 0, 1),
				watch(SEVERANCE, 1, 2)
			],
			exportedAt: EXPORTED_AT
		});

		expect(doc.titles[0].watchedEpisodes).toEqual([
			{ season: 0, episode: 1 },
			{ season: 1, episode: 2 },
			{ season: 1, episode: 10 },
			{ season: 2, episode: 1 }
		]);
	});

	it('keeps a tracked title whose media row is missing, with null metadata', () => {
		const doc = buildExport({
			tracking: [tracking({ mediaId: SEVERANCE, status: 'watching', rating: 4 })],
			media: [],
			watches: [watch(SEVERANCE, 1, 1)],
			exportedAt: EXPORTED_AT
		});

		expect(doc.titles).toHaveLength(1);
		expect(doc.titles[0]).toMatchObject({
			mediaId: SEVERANCE,
			provider: null,
			externalId: null,
			type: null,
			title: null,
			year: null,
			status: 'watching',
			rating: 4,
			watchedEpisodes: [{ season: 1, episode: 1 }]
		});
	});

	it('orders titles alphabetically, with untitled entries last', () => {
		const doc = buildExport({
			tracking: [
				tracking({ mediaId: 'c' }),
				tracking({ mediaId: 'unknown' }),
				tracking({ mediaId: 'a' }),
				tracking({ mediaId: 'b' })
			],
			media: [
				media({ id: 'c', title: 'Severance' }),
				media({ id: 'a', title: 'Andor' }),
				media({ id: 'b', title: 'Fargo' })
			],
			watches: [],
			exportedAt: EXPORTED_AT
		});

		expect(doc.titles.map((t) => t.title)).toEqual(['Andor', 'Fargo', 'Severance', null]);
	});

	it('reports titleCount matching the exported titles', () => {
		const doc = buildExport({
			tracking: [tracking({ mediaId: 'a' }), tracking({ mediaId: 'b' })],
			media: [],
			watches: [],
			exportedAt: EXPORTED_AT
		});

		expect(doc.titleCount).toBe(2);
		expect(doc.titleCount).toBe(doc.titles.length);
	});
});
