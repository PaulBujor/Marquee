import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '$lib/server/db/test-db';
import { episodes, episodeWatches, media, tracking, users } from '$lib/server/db/schema';
import type { TrackingStatus } from '$lib/sync/events';
import { reconcileShowTrackers, reconcileUserShowStatus } from './reconcile';

type Db = ReturnType<typeof createTestDb>;

const USER = 'user-1';
const SHOW = 'media-show-1';
const MOVIE = 'media-movie-1';
const TODAY = Date.UTC(2026, 6, 24); // 2026-07-24

async function insertUser(db: Db, id = USER): Promise<void> {
	await db.insert(users).values({ id, email: `${id}@x.com`, status: 'enabled' });
}

async function insertShow(db: Db, id: string, inProduction: boolean | null): Promise<void> {
	await db.insert(media).values({ id, type: 'show', title: 'A Show', inProduction });
}

async function insertEpisode(
	db: Db,
	mediaId: string,
	season: number,
	episode: number,
	airDate: string | null
): Promise<void> {
	await db
		.insert(episodes)
		.values({ mediaId, seasonNumber: season, episodeNumber: episode, airDate });
}

async function insertTracking(
	db: Db,
	userId: string,
	mediaId: string,
	status: TrackingStatus,
	statusUpdatedAt = 0
): Promise<void> {
	await db
		.insert(tracking)
		.values({ id: `${userId}::${mediaId}`, userId, mediaId, status, statusUpdatedAt });
}

async function markWatched(
	db: Db,
	userId: string,
	mediaId: string,
	season: number,
	episode: number
): Promise<void> {
	await db
		.insert(episodeWatches)
		.values({
			id: `${userId}::${mediaId}::s${season}e${episode}`,
			userId,
			mediaId,
			season,
			episode,
			watched: true
		});
}

async function trackingRow(db: Db, userId: string, mediaId: string) {
	const [row] = await db
		.select()
		.from(tracking)
		.where(eq(tracking.id, `${userId}::${mediaId}`));
	return row;
}

let db: Db;
beforeEach(async () => {
	db = createTestDb();
	await insertUser(db);
});

describe('reconcileUserShowStatus — insufficient data does not override', () => {
	it('no-ops when there is no media row for the id yet (the seed-before-metadata moment)', async () => {
		await insertTracking(db, USER, SHOW, 'watching');
		await markWatched(db, USER, SHOW, 1, 1);
		await reconcileUserShowStatus(db, USER, SHOW, TODAY);
		expect((await trackingRow(db, USER, SHOW)).status).toBe('watching');
	});

	it('no-ops when the show has episode rows but none have aired', async () => {
		await insertShow(db, SHOW, true);
		await insertEpisode(db, SHOW, 1, 1, '2027-01-01');
		await insertTracking(db, USER, SHOW, 'watching');
		await reconcileUserShowStatus(db, USER, SHOW, TODAY);
		expect((await trackingRow(db, USER, SHOW)).status).toBe('watching');
	});

	it('no-ops for a tracking row that does not exist', async () => {
		await insertShow(db, SHOW, false);
		await insertEpisode(db, SHOW, 1, 1, '2020-01-01');
		await expect(reconcileUserShowStatus(db, USER, SHOW, TODAY)).resolves.toBeUndefined();
	});
});

describe('reconcileUserShowStatus — movies are never touched', () => {
	it.each(['want_to_watch', 'watching', 'completed', 'did_not_finish'] as const)(
		'leaves a movie tracked as %s unchanged',
		async (status) => {
			await db.insert(media).values({ id: MOVIE, type: 'movie', title: 'A Movie' });
			await insertTracking(db, USER, MOVIE, status);
			await reconcileUserShowStatus(db, USER, MOVIE, TODAY);
			expect((await trackingRow(db, USER, MOVIE)).status).toBe(status);
		}
	);
});

describe('reconcileUserShowStatus — the reported bug, fixed at the source', () => {
	it('completes a show once episode data exists, from watches recorded while it did not', async () => {
		// Marks land with no media/episode rows at all yet — mirrors a bulk "mark watched" seeded
		// from season summaries alone landing on the server before the media channel has hydrated
		// this title. Nothing to reconcile against; status is left as whatever the add/mark set.
		await insertTracking(db, USER, SHOW, 'watching');
		await markWatched(db, USER, SHOW, 1, 1);
		await markWatched(db, USER, SHOW, 1, 2);
		await reconcileUserShowStatus(db, USER, SHOW, TODAY);
		expect((await trackingRow(db, USER, SHOW)).status).toBe('watching');

		// Episode data now exists (as if the media channel just hydrated it) — a finished, two-
		// episode season, fully watched, not still airing. No further event of any kind was
		// recorded; this must resolve on its own.
		await insertShow(db, SHOW, false);
		await insertEpisode(db, SHOW, 1, 1, '2020-01-01');
		await insertEpisode(db, SHOW, 1, 2, '2020-01-08');
		await reconcileUserShowStatus(db, USER, SHOW, TODAY);
		expect((await trackingRow(db, USER, SHOW)).status).toBe('completed');
	});
});

describe('reconcileUserShowStatus — explicit did_not_finish is never overridden', () => {
	it('stays did_not_finish even with every aired episode watched', async () => {
		await insertShow(db, SHOW, false);
		await insertEpisode(db, SHOW, 1, 1, '2020-01-01');
		await insertTracking(db, USER, SHOW, 'did_not_finish');
		await markWatched(db, USER, SHOW, 1, 1);
		await reconcileUserShowStatus(db, USER, SHOW, TODAY);
		expect((await trackingRow(db, USER, SHOW)).status).toBe('did_not_finish');
	});
});

describe('reconcileUserShowStatus — LWW guard', () => {
	it('does not clobber a status_updated_at newer than the reconcile clock', async () => {
		await insertShow(db, SHOW, false);
		await insertEpisode(db, SHOW, 1, 1, '2020-01-01');
		// statusUpdatedAt is already ahead of the reconcile clock below — e.g. a genuinely newer
		// explicit status change that raced this reconcile.
		await insertTracking(db, USER, SHOW, 'watching', TODAY + 10_000);
		await markWatched(db, USER, SHOW, 1, 1);
		await reconcileUserShowStatus(db, USER, SHOW, TODAY);
		expect((await trackingRow(db, USER, SHOW)).status).toBe('watching');
	});
});

describe('reconcileShowTrackers — season added after the show was marked complete', () => {
	it('demotes a completed tracker back to watching once a new unwatched episode has aired', async () => {
		await insertShow(db, SHOW, true);
		await insertEpisode(db, SHOW, 1, 1, '2020-01-01');
		await markWatched(db, USER, SHOW, 1, 1);
		await insertTracking(db, USER, SHOW, 'completed');

		// Season 2 lands with an already-aired episode nobody's watched.
		await insertEpisode(db, SHOW, 2, 1, '2020-06-01');
		await reconcileShowTrackers(db, SHOW, TODAY);
		expect((await trackingRow(db, USER, SHOW)).status).toBe('watching');
	});

	it('demotes even before the new season airs — an announced-but-unaired episode already means "not finished"', async () => {
		// Matches `isStillAiring`: an announced future episode keeps a show out of `completed`
		// even with zero new aired content (see `derive-status.test.ts`'s equivalent client case).
		await insertShow(db, SHOW, true);
		await insertEpisode(db, SHOW, 1, 1, '2020-01-01');
		await markWatched(db, USER, SHOW, 1, 1);
		await insertTracking(db, USER, SHOW, 'completed');

		await insertEpisode(db, SHOW, 2, 1, '2027-01-01'); // unaired
		await reconcileShowTrackers(db, SHOW, TODAY);
		expect((await trackingRow(db, USER, SHOW)).status).toBe('watching');
	});

	it('reopens completed when the show starts airing again with nothing new watched', async () => {
		await insertShow(db, SHOW, false);
		await insertEpisode(db, SHOW, 1, 1, '2020-01-01');
		await markWatched(db, USER, SHOW, 1, 1);
		await insertTracking(db, USER, SHOW, 'completed');

		await db.update(media).set({ inProduction: true }).where(eq(media.id, SHOW));
		await reconcileShowTrackers(db, SHOW, TODAY);
		expect((await trackingRow(db, USER, SHOW)).status).toBe('watching');
	});

	it('reconciles multiple trackers of the same show independently', async () => {
		const USER2 = 'user-2';
		await insertUser(db, USER2);
		await insertShow(db, SHOW, true);
		await insertEpisode(db, SHOW, 1, 1, '2020-01-01');
		await markWatched(db, USER, SHOW, 1, 1); // caught up
		// USER2 has not watched anything.
		await insertTracking(db, USER, SHOW, 'completed');
		await insertTracking(db, USER2, SHOW, 'watching');

		await insertEpisode(db, SHOW, 1, 2, '2020-01-08');
		await reconcileShowTrackers(db, SHOW, TODAY);
		expect((await trackingRow(db, USER, SHOW)).status).toBe('watching'); // demoted: newly behind
		expect((await trackingRow(db, USER2, SHOW)).status).toBe('watching'); // unaffected: already behind
	});

	it('ignores removed and want_to_watch/did_not_finish trackers', async () => {
		const NOT_WATCHING = 'user-2';
		const REMOVED = 'user-3';
		await insertUser(db, NOT_WATCHING);
		await insertUser(db, REMOVED);
		await insertShow(db, SHOW, false);
		await insertEpisode(db, SHOW, 1, 1, '2020-01-01');
		await insertTracking(db, USER, SHOW, 'want_to_watch');
		await insertTracking(db, NOT_WATCHING, SHOW, 'did_not_finish');
		await db
			.insert(tracking)
			.values({
				id: `${REMOVED}::${SHOW}`,
				userId: REMOVED,
				mediaId: SHOW,
				status: 'completed',
				removed: true
			});

		await reconcileShowTrackers(db, SHOW, TODAY);
		expect((await trackingRow(db, USER, SHOW)).status).toBe('want_to_watch');
		expect((await trackingRow(db, NOT_WATCHING, SHOW)).status).toBe('did_not_finish');
		expect((await trackingRow(db, REMOVED, SHOW)).status).toBe('completed'); // untouched, tombstoned
	});
});
