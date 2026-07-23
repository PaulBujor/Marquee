import { describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/db/test-db';
import { mediaId } from '$lib/sync/events';
import type { MediaDetail } from '$lib/server/tmdb';
import { hydrateMedia, parseTmdbExternalId } from './hydrate';

/** A TMDB client stub exposing only `getDetails`, counting calls. */
function stub(overrides: Partial<MediaDetail> = {}) {
	let calls = 0;
	const getDetails = async (type: 'movie' | 'show', id: number): Promise<MediaDetail> => {
		calls++;
		return {
			tmdbId: id,
			type,
			title: 'The Matrix',
			year: 1999,
			overview: 'Neo.',
			posterPath: '/poster.jpg',
			backdropPath: '/backdrop.jpg',
			rating: 8.3,
			voteCount: 100,
			runtime: 136,
			genres: ['Action'],
			cast: [],
			trailer: null,
			seasons: [],
			lastAired: null,
			...overrides
		};
	};
	return { client: { getDetails }, calls: () => calls };
}

describe('parseTmdbExternalId', () => {
	it('parses movie/show external ids', () => {
		expect(parseTmdbExternalId('movie/603')).toEqual({ type: 'movie', tmdbId: 603 });
		expect(parseTmdbExternalId('show/1396')).toEqual({ type: 'show', tmdbId: 1396 });
	});

	it('rejects anything malformed', () => {
		expect(parseTmdbExternalId('603')).toBeNull();
		expect(parseTmdbExternalId('movie/abc')).toBeNull();
		expect(parseTmdbExternalId('person/1')).toBeNull();
		expect(parseTmdbExternalId('')).toBeNull();
	});
});

describe('hydrateMedia', () => {
	it('fetches from TMDB and stores a linked row keyed by our id', async () => {
		const db = createTestDb();
		const { client, calls } = stub();
		const row = await hydrateMedia(db, client, 'tmdb', 'movie/603');
		expect(row).toMatchObject({
			id: mediaId('tmdb', 'movie/603'),
			provider: 'tmdb',
			externalId: 'movie/603',
			source: 'linked',
			type: 'movie',
			title: 'The Matrix',
			backdropPath: '/backdrop.jpg',
			seasons: null
		});
		expect(calls()).toBe(1);
	});

	it('serves a cached row without hitting TMDB again', async () => {
		const db = createTestDb();
		const { client, calls } = stub();
		await hydrateMedia(db, client, 'tmdb', 'movie/603');
		await hydrateMedia(db, client, 'tmdb', 'movie/603');
		expect(calls()).toBe(1);
	});

	it('stores season counts for shows', async () => {
		const db = createTestDb();
		const { client } = stub({
			type: 'show',
			seasons: [
				{
					seasonNumber: 1,
					name: 'S1',
					episodeCount: 7,
					airYear: 2008,
					posterPath: null,
					overview: ''
				},
				{
					seasonNumber: 2,
					name: 'S2',
					episodeCount: 13,
					airYear: 2009,
					posterPath: null,
					overview: ''
				}
			]
		});
		const row = await hydrateMedia(db, client, 'tmdb', 'show/1396');
		expect(row?.seasons).toEqual([
			{ seasonNumber: 1, episodeCount: 7 },
			{ seasonNumber: 2, episodeCount: 13 }
		]);
	});

	it('returns null for an unknown provider or malformed id without calling TMDB', async () => {
		const db = createTestDb();
		const { client, calls } = stub();
		expect(await hydrateMedia(db, client, 'tmdb', 'nope')).toBeNull();
		// @ts-expect-error — exercising an unknown provider guard
		expect(await hydrateMedia(db, client, 'omdb', 'movie/603')).toBeNull();
		expect(calls()).toBe(0);
	});
});
