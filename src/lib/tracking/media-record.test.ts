import { describe, expect, it } from 'vitest';
import { tmdbExternalId, tmdbMediaId } from '$lib/sync/events';
import { mediaRecordFromSearch } from './media-record';

describe('mediaRecordFromSearch', () => {
	it('builds a linked, behind (version 0) snapshot with our derived id', () => {
		const record = mediaRecordFromSearch({
			tmdbId: 27205,
			type: 'movie',
			title: 'Inception',
			year: 2010,
			posterPath: '/inception.jpg',
			overview: 'A thief.'
		});
		expect(record).toEqual({
			id: tmdbMediaId('movie', 27205),
			provider: 'tmdb',
			externalId: tmdbExternalId('movie', 27205),
			source: 'linked',
			type: 'movie',
			title: 'Inception',
			year: 2010,
			posterPath: '/inception.jpg',
			backdropPath: null,
			overview: 'A thief.',
			genres: [],
			releaseDate: null,
			status: null,
			inProduction: null,
			firstAirDate: null,
			lastAirDate: null,
			version: 0,
			seasons: null,
			episodes: null
		});
	});

	it('defaults a missing overview to empty string', () => {
		const record = mediaRecordFromSearch({
			tmdbId: 1396,
			type: 'show',
			title: 'Breaking Bad',
			year: 2008,
			posterPath: null
		});
		expect(record.overview).toBe('');
		expect(record.type).toBe('show');
		expect(record.version).toBe(0);
	});
});
