import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '$lib/server/db/test-db';
import { episodes, seasons } from '$lib/server/db/schema';
import { mediaId } from '$lib/sync/events';
import type { MediaDetail, SeasonDetail } from '$lib/server/tmdb';
import { needsRefresh, parseTmdbExternalId, refreshMedia } from './hydrate';

const T0 = Date.UTC(2026, 6, 24); // fixed "now" for deterministic TTL tests

const movieDefaults: MediaDetail = {
	tmdbId: 603,
	type: 'movie',
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
	releaseDate: '1999-03-31',
	status: null,
	inProduction: null,
	firstAirDate: null,
	lastAirDate: null,
	seasons: []
};

/** A movie TMDB stub exposing getDetails + getSeason, counting detail calls. */
function movieStub(overrides: Partial<MediaDetail> = {}) {
	let detailCalls = 0;
	return {
		detailCalls: () => detailCalls,
		client: {
			async getDetails(type: 'movie' | 'show', id: number): Promise<MediaDetail> {
				detailCalls++;
				return { ...movieDefaults, tmdbId: id, type, ...overrides };
			},
			async getSeason(): Promise<SeasonDetail> {
				return { seasonNumber: 0, name: '', episodes: [] };
			}
		}
	};
}

/**
 * A show TMDB stub whose episode set + production status can be mutated between refreshes,
 * so a re-pull can observe a newly-aired episode or a status flip.
 */
function showStub() {
	let detailCalls = 0;
	let inProduction = true;
	const episodesBySeason: Record<number, { episodeNumber: number; airDate: string | null }[]> = {
		1: [
			{ episodeNumber: 1, airDate: '2026-01-01' },
			{ episodeNumber: 2, airDate: '2026-08-01' }
		]
	};
	return {
		detailCalls: () => detailCalls,
		addEpisode(ep: { episodeNumber: number; airDate: string | null }) {
			episodesBySeason[1].push(ep);
		},
		endProduction() {
			inProduction = false;
		},
		client: {
			async getDetails(type: 'movie' | 'show', id: number): Promise<MediaDetail> {
				detailCalls++;
				return {
					...movieDefaults,
					tmdbId: id,
					type: 'show',
					title: 'Airing Show',
					inProduction,
					status: inProduction ? 'Returning Series' : 'Ended',
					firstAirDate: '2026-01-01',
					lastAirDate: '2026-01-01',
					seasons: [
						{
							seasonNumber: 1,
							name: 'Season 1',
							episodeCount: episodesBySeason[1].length,
							airDate: '2026-01-01',
							posterPath: null,
							overview: ''
						}
					]
				};
			},
			async getSeason(_showId: number, seasonNumber: number): Promise<SeasonDetail> {
				return {
					seasonNumber,
					name: `Season ${seasonNumber}`,
					episodes: (episodesBySeason[seasonNumber] ?? []).map((e) => ({
						episodeNumber: e.episodeNumber,
						name: `E${e.episodeNumber}`,
						airDate: e.airDate,
						overview: '',
						stillPath: null,
						runtime: 42
					}))
				};
			}
		}
	};
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

describe('needsRefresh', () => {
	const base = { type: 'show' as const, status: 'Returning Series', inProduction: true };
	it('always refreshes a pre-relational row (refreshedAt 0)', () => {
		expect(needsRefresh({ ...base, refreshedAt: 0 } as never, T0)).toBe(true);
	});
	it('never refreshes a movie once hydrated', () => {
		expect(needsRefresh({ type: 'movie', refreshedAt: T0 } as never, T0 + 5e9)).toBe(false);
	});
	it('refreshes an airing show only past the TTL', () => {
		expect(needsRefresh({ ...base, refreshedAt: T0 } as never, T0 + 1000)).toBe(false);
		expect(needsRefresh({ ...base, refreshedAt: T0 } as never, T0 + 13 * 3600_000)).toBe(true);
	});
	it('never refreshes a finished show', () => {
		const ended = { type: 'show' as const, status: 'Ended', inProduction: false };
		expect(needsRefresh({ ...ended, refreshedAt: T0 } as never, T0 + 5e9)).toBe(false);
	});
});

describe('refreshMedia', () => {
	it('fetches from TMDB and stores a linked movie row keyed by our id', async () => {
		const db = createTestDb();
		const { client, detailCalls } = movieStub();
		const row = await refreshMedia(db, client, 'tmdb', 'movie/603', T0);
		expect(row).toMatchObject({
			id: mediaId('tmdb', 'movie/603'),
			provider: 'tmdb',
			externalId: 'movie/603',
			source: 'linked',
			type: 'movie',
			title: 'The Matrix',
			backdropPath: '/backdrop.jpg',
			releaseDate: '1999-03-31',
			version: 1,
			refreshedAt: T0
		});
		expect(detailCalls()).toBe(1);
	});

	it('serves a cached movie without hitting TMDB again', async () => {
		const db = createTestDb();
		const { client, detailCalls } = movieStub();
		await refreshMedia(db, client, 'tmdb', 'movie/603', T0);
		await refreshMedia(db, client, 'tmdb', 'movie/603', T0 + 5e9);
		expect(detailCalls()).toBe(1);
	});

	it('stores seasons + episodes (with air dates) for a show', async () => {
		const db = createTestDb();
		const { client } = showStub();
		const row = await refreshMedia(db, client, 'tmdb', 'show/1396', T0);
		const id = row!.id;
		expect(row).toMatchObject({ type: 'show', status: 'Returning Series', inProduction: true });

		const seasonRows = await db.select().from(seasons).where(eq(seasons.mediaId, id));
		expect(seasonRows).toHaveLength(1);
		expect(seasonRows[0]).toMatchObject({ seasonNumber: 1, episodeCount: 2 });

		const episodeRows = await db.select().from(episodes).where(eq(episodes.mediaId, id));
		expect(episodeRows.map((e) => [e.seasonNumber, e.episodeNumber, e.airDate])).toEqual([
			[1, 1, '2026-01-01'],
			[1, 2, '2026-08-01']
		]);
	});

	it('within the TTL, returns the cached show without re-fetching', async () => {
		const db = createTestDb();
		const stub = showStub();
		await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0);
		await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0 + 1000);
		expect(stub.detailCalls()).toBe(1);
	});

	it('past the TTL, re-pulls and bumps version when a new episode aired', async () => {
		const db = createTestDb();
		const stub = showStub();
		const id = mediaId('tmdb', 'show/1396');
		const first = await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0);
		expect(first!.version).toBe(1);

		stub.addEpisode({ episodeNumber: 3, airDate: '2026-09-01' });
		const second = await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0 + 13 * 3600_000);
		expect(stub.detailCalls()).toBe(2);
		expect(second!.version).toBe(2);
		const episodeRows = await db.select().from(episodes).where(eq(episodes.mediaId, id));
		expect(episodeRows).toHaveLength(3);
	});

	it('past the TTL, re-pulls but keeps version when nothing changed', async () => {
		const db = createTestDb();
		const stub = showStub();
		await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0);
		const second = await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0 + 13 * 3600_000);
		expect(stub.detailCalls()).toBe(2);
		expect(second!.version).toBe(1);
	});

	it('returns null for an unknown provider or malformed id without calling TMDB', async () => {
		const db = createTestDb();
		const { client, detailCalls } = movieStub();
		expect(await refreshMedia(db, client, 'tmdb', 'nope', T0)).toBeNull();
		// @ts-expect-error — exercising an unknown provider guard
		expect(await refreshMedia(db, client, 'omdb', 'movie/603', T0)).toBeNull();
		expect(detailCalls()).toBe(0);
	});
});
