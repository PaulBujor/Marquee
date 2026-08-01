/**
 * The acceptance criterion for data portability: export an account, wipe it, import the file, and
 * get the same library back.
 *
 * Exercised end to end against the **real server projection** on in-memory SQLite with the
 * committed migrations applied — so this proves the document survives the same code path a live
 * import would take (client → `/api/sync` → projection), not just the client's own view of it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '$lib/server/db/test-db';
import { episodeWatches, tracking, users } from '$lib/server/db/schema';
import { tmdbExternalId, tmdbMediaId } from '$lib/sync/events';
import { applyEvents } from '$lib/server/sync/projection';
import type { ClientEpisodeWatch, ClientMedia, ClientTracking } from '$lib/client/idb';
import { buildExport } from './build';
import { parseExport } from './parse';
import { planImport } from './plan';

type Db = ReturnType<typeof createTestDb>;

const USER = 'user-1';
const DEVICE = '11111111-1111-1111-1111-111111111111';
const EXPORTED_AT = new Date('2026-08-01T14:22:03.451Z');

const SEVERANCE = tmdbMediaId('show', 95396);
const INCEPTION = tmdbMediaId('movie', 27205);

// Deliberately distinct: added long before watched, and each episode seen on its own day, so the
// round trip has to preserve dates rather than collapse them onto one clock.
const SEVERANCE_ADDED_AT = Date.UTC(2026, 0, 5, 9, 0, 0);
const SEVERANCE_EP_WATCHED_AT = [
	Date.UTC(2026, 1, 14, 20, 0, 0),
	Date.UTC(2026, 1, 21, 20, 30, 0),
	Date.UTC(2026, 2, 7, 22, 15, 0)
];
const SEVERANCE_COMPLETED_AT = Date.UTC(2026, 2, 7, 22, 20, 0);
const INCEPTION_ADDED_AT = Date.UTC(2025, 10, 2, 12, 0, 0);
const INCEPTION_WATCHED_AT = Date.UTC(2026, 5, 20, 18, 0, 0);

/** The library we'll export, destroy and restore. */
const ORIGINAL_TRACKING: ClientTracking[] = [
	{
		mediaId: SEVERANCE,
		status: 'watching',
		favorite: true,
		rating: 4,
		removed: false,
		statusUpdatedAt: SEVERANCE_COMPLETED_AT,
		favoriteUpdatedAt: SEVERANCE_COMPLETED_AT,
		ratingUpdatedAt: SEVERANCE_COMPLETED_AT,
		removedUpdatedAt: 0,
		addedAt: SEVERANCE_ADDED_AT
	},
	{
		mediaId: INCEPTION,
		status: 'completed',
		favorite: false,
		rating: 5,
		removed: false,
		statusUpdatedAt: INCEPTION_WATCHED_AT,
		favoriteUpdatedAt: INCEPTION_WATCHED_AT,
		ratingUpdatedAt: INCEPTION_WATCHED_AT,
		removedUpdatedAt: 0,
		addedAt: INCEPTION_ADDED_AT
	}
];

function media(id: string, type: 'movie' | 'show', title: string, external: string): ClientMedia {
	return {
		id,
		provider: 'tmdb',
		externalId: external,
		source: 'linked',
		type,
		title,
		year: 2022,
		posterPath: null,
		backdropPath: null,
		overview: '',
		genres: [],
		releaseDate: null,
		status: null,
		inProduction: null,
		firstAirDate: null,
		lastAirDate: null,
		version: 7,
		updatedAt: 1_700_000_000_000
	};
}

const ORIGINAL_MEDIA: ClientMedia[] = [
	media(SEVERANCE, 'show', 'Severance', tmdbExternalId('show', 95396)),
	media(INCEPTION, 'movie', 'Inception', tmdbExternalId('movie', 27205))
];

function watch(
	season: number,
	episode: number,
	updatedAt: number,
	watched = true
): ClientEpisodeWatch {
	return {
		id: `${SEVERANCE}::s${season}e${episode}`,
		mediaId: SEVERANCE,
		season,
		episode,
		watched,
		updatedAt
	};
}

const ORIGINAL_WATCHES: ClientEpisodeWatch[] = [
	watch(1, 1, SEVERANCE_EP_WATCHED_AT[0]),
	watch(1, 2, SEVERANCE_EP_WATCHED_AT[1]),
	watch(1, 3, SEVERANCE_COMPLETED_AT, false), // started then un-marked — must not come back
	watch(2, 1, SEVERANCE_EP_WATCHED_AT[2])
];

describe('export → import round trip', () => {
	let db: Db;

	beforeEach(async () => {
		db = createTestDb();
		await db.insert(users).values({ id: USER, email: 'round@trip.test', status: 'enabled' });
	});

	/** Export the fixture library, serialise it, and read it back the way import would. */
	function exportAndReparse() {
		const doc = buildExport({
			tracking: ORIGINAL_TRACKING,
			media: ORIGINAL_MEDIA,
			watches: ORIGINAL_WATCHES,
			exportedAt: EXPORTED_AT
		});
		const result = parseExport(JSON.stringify(doc, null, 2));
		if (!result.ok) throw new Error(`export did not survive its own parser: ${result.reason}`);
		return result.doc;
	}

	it('restores every title with its status, rating and favorite', async () => {
		const plan = planImport(exportAndReparse(), DEVICE);
		await applyEvents(db, USER, plan.events);

		const rows = await db.select().from(tracking).where(eq(tracking.userId, USER));
		expect(rows).toHaveLength(2);

		const severance = rows.find((r) => r.mediaId === SEVERANCE);
		expect(severance).toMatchObject({ status: 'watching', favorite: true, rating: 4 });

		const inception = rows.find((r) => r.mediaId === INCEPTION);
		expect(inception).toMatchObject({ status: 'completed', favorite: false, rating: 5 });
	});

	it('restores episode progress without reviving un-watched episodes', async () => {
		const plan = planImport(exportAndReparse(), DEVICE);
		await applyEvents(db, USER, plan.events);

		const rows = await db.select().from(episodeWatches).where(eq(episodeWatches.userId, USER));

		const watched = rows
			.filter((r) => r.watched)
			.map((r) => `s${r.season}e${r.episode}`)
			.sort();
		expect(watched).toEqual(['s1e1', 's1e2', 's2e1']);
		expect(rows.some((r) => r.season === 1 && r.episode === 3)).toBe(false);
	});

	it('preserves the original date added rather than stamping the import time', async () => {
		const plan = planImport(exportAndReparse(), DEVICE);
		await applyEvents(db, USER, plan.events);

		const rows = await db.select().from(tracking).where(eq(tracking.userId, USER));
		expect(rows.find((r) => r.mediaId === SEVERANCE)?.addedAt).toEqual(
			new Date(SEVERANCE_ADDED_AT)
		);
		expect(rows.find((r) => r.mediaId === INCEPTION)?.addedAt).toEqual(
			new Date(INCEPTION_ADDED_AT)
		);
	});

	it("restores a movie's watch date, which is its completion clock", async () => {
		const plan = planImport(exportAndReparse(), DEVICE);
		await applyEvents(db, USER, plan.events);

		const rows = await db.select().from(tracking).where(eq(tracking.userId, USER));
		const inception = rows.find((r) => r.mediaId === INCEPTION);
		// Watched in June, added the previous November — the two must not collapse together.
		expect(inception?.statusUpdatedAt).toBe(INCEPTION_WATCHED_AT);
		expect(inception?.statusUpdatedAt).not.toBe(INCEPTION_ADDED_AT);
	});

	it('restores the date each episode was marked watched', async () => {
		const plan = planImport(exportAndReparse(), DEVICE);
		await applyEvents(db, USER, plan.events);

		const rows = await db.select().from(episodeWatches).where(eq(episodeWatches.userId, USER));
		const byCoord = new Map(rows.map((r) => [`s${r.season}e${r.episode}`, r.updatedAt]));
		expect(byCoord.get('s1e1')).toBe(SEVERANCE_EP_WATCHED_AT[0]);
		expect(byCoord.get('s1e2')).toBe(SEVERANCE_EP_WATCHED_AT[1]);
		expect(byCoord.get('s2e1')).toBe(SEVERANCE_EP_WATCHED_AT[2]);
	});

	it("restores a show's last-watched date as its newest episode watch", async () => {
		const plan = planImport(exportAndReparse(), DEVICE);
		await applyEvents(db, USER, plan.events);

		const rows = await db.select().from(episodeWatches).where(eq(episodeWatches.userId, USER));
		const newest = Math.max(...rows.filter((r) => r.watched).map((r) => r.updatedAt));
		expect(newest).toBe(Math.max(...SEVERANCE_EP_WATCHED_AT));
	});

	it('re-exports to an identical document after the round trip', async () => {
		const before = buildExport({
			tracking: ORIGINAL_TRACKING,
			media: ORIGINAL_MEDIA,
			watches: ORIGINAL_WATCHES,
			exportedAt: EXPORTED_AT
		});

		const plan = planImport(exportAndReparse(), DEVICE);
		await applyEvents(db, USER, plan.events);

		// Rebuild client-shaped rows from what the server now holds, then export those.
		const trackingRows = await db.select().from(tracking).where(eq(tracking.userId, USER));
		const watchRows = await db.select().from(episodeWatches).where(eq(episodeWatches.userId, USER));

		const after = buildExport({
			tracking: trackingRows.map((r) => ({
				mediaId: r.mediaId,
				status: r.status,
				favorite: r.favorite,
				rating: r.rating,
				removed: r.removed,
				statusUpdatedAt: r.statusUpdatedAt,
				favoriteUpdatedAt: r.favoriteUpdatedAt,
				ratingUpdatedAt: r.ratingUpdatedAt,
				removedUpdatedAt: r.removedUpdatedAt,
				addedAt: r.addedAt.getTime()
			})),
			// Media arrives on its own channel; the stubs carry the same identity fields.
			media: plan.media.map((m) => ({ ...m, updatedAt: 0 })),
			watches: watchRows.map((r) => ({
				id: r.id,
				mediaId: r.mediaId,
				season: r.season,
				episode: r.episode,
				watched: r.watched,
				updatedAt: r.updatedAt
			})),
			exportedAt: EXPORTED_AT
		});

		expect(after.titles).toEqual(before.titles);
	});

	it('seeds far fewer events than a user would have generated', async () => {
		const plan = planImport(exportAndReparse(), DEVICE);

		// 2 adds + 2 status changes (both titles were watched after being added) + 1 favorite
		// + 2 ratings + 3 watched episodes. No invented intermediate statuses, and no unwatch for
		// the episode that was un-marked before the export.
		expect(plan.events).toHaveLength(10);
		expect(plan.events.filter((e) => e.type === 'episode.unwatched')).toHaveLength(0);
	});
});
