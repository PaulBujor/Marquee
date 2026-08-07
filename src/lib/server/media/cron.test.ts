import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '$lib/server/db/test-db';
import { media } from '$lib/server/db/schema';
import { mediaId } from '$lib/sync/events';
import type { MediaDetail, SeasonDetail } from '$lib/server/tmdb';
import { CRON_REFRESH_MAX, refreshStaleMedia } from './cron';

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
					director: null,
					writers: [],
					producers: [],
					creators: [],
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
	over: {
		type: 'movie' | 'show';
		inProduction?: boolean | null;
		releaseDate?: string | null;
		status?: string | null;
	}
) {
	await db.insert(media).values({
		id: mediaId('tmdb', externalId),
		provider: 'tmdb',
		externalId,
		source: 'linked',
		type: over.type,
		title: externalId,
		inProduction: over.inProduction ?? null,
		releaseDate: over.releaseDate ?? null,
		status: over.status ?? null,
		version: 1,
		refreshedAt: 0
	});
}

describe('refreshStaleMedia', () => {
	it('refreshes in-production shows + unreleased movies (skips finished shows + released movies)', async () => {
		const db = createTestDb();
		await seedMedia(db, 'show/1', { type: 'show', inProduction: true });
		await seedMedia(db, 'show/2', { type: 'show', inProduction: false }); // finished → skip
		await seedMedia(db, 'movie/3', { type: 'movie', releaseDate: null }); // undated → unreleased
		await seedMedia(db, 'movie/4', { type: 'movie', releaseDate: '2027-01-01' }); // future → unreleased
		await seedMedia(db, 'movie/5', { type: 'movie', releaseDate: '2020-01-01' }); // released → skip

		const { client, detailCalls } = stub();
		const result = await refreshStaleMedia(db, client, T0);

		// show/1 + movie/3 + movie/4 are unsettled; show/2 + movie/5 are settled.
		expect(result.scanned).toBe(3);
		expect(detailCalls()).toBe(3);
		expect(result.changed).toBe(3);

		const [show] = await db
			.select()
			.from(media)
			.where(eq(media.id, mediaId('tmdb', 'show/1')));
		expect(show.refreshedAt).toBe(T0);
	});

	it('returns zeroes when nothing is unsettled', async () => {
		const db = createTestDb();
		await seedMedia(db, 'show/8', { type: 'show', inProduction: false });
		await seedMedia(db, 'movie/9', { type: 'movie', releaseDate: '2020-01-01' });
		const { client } = stub();
		expect(await refreshStaleMedia(db, client, T0)).toEqual({
			scanned: 0,
			attempted: 0,
			changed: 0,
			failed: 0,
			capped: false
		});
	});

	it('sweeps a between-seasons show — in_production false but an airing status', async () => {
		const db = createTestDb();
		// The case `needsRefresh` covers via AIRING_STATUSES; the sweep has to match the same rule.
		await seedMedia(db, 'show/42', {
			type: 'show',
			inProduction: false,
			status: 'Returning Series'
		});
		const { client, detailCalls } = stub();
		const result = await refreshStaleMedia(db, client, T0);
		expect(result.scanned).toBe(1);
		expect(result.attempted).toBe(1);
		expect(detailCalls()).toBe(1);
	});

	it('counts a show matching both show branches once', async () => {
		const db = createTestDb();
		await seedMedia(db, 'show/43', {
			type: 'show',
			inProduction: true,
			status: 'Returning Series'
		});
		const { client } = stub();
		const result = await refreshStaleMedia(db, client, T0);
		expect(result.scanned).toBe(1);
		expect(result.attempted).toBe(1);
	});

	it('caps a run at CRON_REFRESH_MAX and reports the overflow', async () => {
		const db = createTestDb();
		for (let i = 0; i < CRON_REFRESH_MAX + 5; i++) {
			await seedMedia(db, `show/${1000 + i}`, { type: 'show', inProduction: true });
		}
		const { client } = stub();
		const result = await refreshStaleMedia(db, client, T0);
		expect(result.scanned).toBe(CRON_REFRESH_MAX + 5);
		expect(result.attempted).toBe(CRON_REFRESH_MAX);
		expect(result.capped).toBe(true);
	});
});
