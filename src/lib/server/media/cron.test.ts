import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '$lib/server/db/test-db';
import { media } from '$lib/server/db/schema';
import { mediaId } from '$lib/sync/events';
import type { MediaDetail, SeasonDetail } from '$lib/server/tmdb';
import { refreshInProductionShows } from './cron';

const T0 = Date.UTC(2026, 6, 24);

/** A TMDB stub that counts getDetails calls and returns a one-episode show. */
function stub() {
	let detailCalls = 0;
	return {
		detailCalls: () => detailCalls,
		client: {
			async getDetails(type: 'movie' | 'show', id: number): Promise<MediaDetail> {
				detailCalls++;
				return {
					tmdbId: id,
					type,
					title: `title-${id}`,
					year: 2026,
					overview: '',
					posterPath: null,
					backdropPath: null,
					rating: null,
					voteCount: 0,
					runtime: null,
					genres: [],
					cast: [],
					trailer: null,
					releaseDate: null,
					status: 'Returning Series',
					inProduction: true,
					firstAirDate: '2026-01-01',
					lastAirDate: '2026-07-01',
					seasons: [
						{
							seasonNumber: 1,
							name: 'S1',
							episodeCount: 1,
							airDate: '2026-01-01',
							posterPath: null,
							overview: ''
						}
					],
					similar: []
				};
			},
			async getSeason(_showId: number, seasonNumber: number): Promise<SeasonDetail> {
				return {
					seasonNumber,
					name: `S${seasonNumber}`,
					episodes: [
						{
							episodeNumber: 1,
							name: 'E1',
							airDate: '2026-01-01',
							overview: '',
							stillPath: null,
							runtime: 42
						}
					]
				};
			}
		}
	};
}

/** Insert a bare media row (refreshedAt 0 ⇒ always considered stale). */
async function seedMedia(
	db: ReturnType<typeof createTestDb>,
	externalId: string,
	over: { type: 'movie' | 'show'; inProduction: boolean | null }
) {
	await db.insert(media).values({
		id: mediaId('tmdb', externalId),
		provider: 'tmdb',
		externalId,
		source: 'linked',
		type: over.type,
		title: externalId,
		inProduction: over.inProduction,
		version: 1,
		refreshedAt: 0
	});
}

describe('refreshInProductionShows', () => {
	it('refreshes only in-production shows (skips movies + finished shows)', async () => {
		const db = createTestDb();
		await seedMedia(db, 'show/1', { type: 'show', inProduction: true });
		await seedMedia(db, 'show/2', { type: 'show', inProduction: false });
		await seedMedia(db, 'movie/3', { type: 'movie', inProduction: null });

		const { client, detailCalls } = stub();
		const result = await refreshInProductionShows(db, client, T0);

		expect(result.scanned).toBe(1);
		expect(detailCalls()).toBe(1); // only show/1 hit TMDB

		// The refreshed show gained episodes → its version bumped.
		expect(result.changed).toBe(1);
		const [row] = await db
			.select()
			.from(media)
			.where(eq(media.id, mediaId('tmdb', 'show/1')));
		expect(row.version).toBe(2);
		expect(row.refreshedAt).toBe(T0);
	});

	it('returns zeroes when there are no in-production shows', async () => {
		const db = createTestDb();
		await seedMedia(db, 'movie/9', { type: 'movie', inProduction: null });
		const { client } = stub();
		expect(await refreshInProductionShows(db, client, T0)).toEqual({
			scanned: 0,
			changed: 0,
			failed: 0
		});
	});
});
