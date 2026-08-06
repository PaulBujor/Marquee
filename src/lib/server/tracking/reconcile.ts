/**
 * Server-side status reconciliation — the write-time counterpart to the client's read-time
 * `deriveStatus` backstop (`src/lib/tracking/derive-status.ts`). `tracking.status` also drives a
 * plain SQL filter (the notify digest's `status IN (...)`), which can't run a per-row derivation,
 * so the *stored* value has to stay correct on its own rather than relying on a client to render
 * it and self-correct.
 *
 * `reconciledStatus`'s two inputs — watched progress and aired-episode/production data — can each
 * change independently, so there are two triggers:
 *
 * - Watched progress changes (an `episode.watched`/`unwatched` event lands) — {@link reconcileUserShowStatus},
 *   called once per affected show at the end of `applyEvents`, for that one user.
 * - The show's episode/production data changes (a new season, a still-airing flip, or — critically —
 *   episode data arriving for the *first* time after watches were already recorded, since a client
 *   can mark a season watched from summary counts alone before per-episode air dates ever sync,
 *   client- or server-side) — {@link reconcileShowTrackers}, called from `refreshMedia` itself, the
 *   one place a show's stored content can change, for every one of its trackers. Wiring it there
 *   instead of in each caller (today: the nightly cron and the first-hydrate path) means every
 *   current and future caller gets it automatically instead of each having to remember to.
 *
 * Both scope to `watching`/`completed` trackers only: `want_to_watch` can't have nonzero watched
 * progress to reconcile from (marking an episode always promotes to `watching` first, see
 * `TrackingState#ensureTracked`), and `did_not_finish` is never auto-overridden (`reconciledStatus`
 * itself passes it through unchanged).
 *
 * Writes are guarded the same way `projectEvent`'s upserts are (`clock >= status_updated_at`), so a
 * genuinely newer explicit status change from the user always wins the race.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
	airedEpisodes,
	isStillAiring,
	reconciledStatus,
	todayIso,
	watchedKey
} from '$lib/tracking/actions';
import type { DatedEpisode } from '$lib/tracking/actions';
import { trackingKey, type TrackingStatus } from '$lib/sync/events';
import type { createDb } from '../db';
import { episodes as episodesTable, episodeWatches, media, tracking } from '../db/schema';

type Db = ReturnType<typeof createDb>;

/** D1 caps bound params per query; chunk `IN (...)` id lists well under that. */
const CHUNK = 90;

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

async function loadShowEpisodes(db: Db, mediaId: string): Promise<DatedEpisode[]> {
	const rows = await db
		.select({
			season: episodesTable.seasonNumber,
			episode: episodesTable.episodeNumber,
			airDate: episodesTable.airDate
		})
		.from(episodesTable)
		.where(eq(episodesTable.mediaId, mediaId));
	return rows;
}

/** Guarded write of a reconciled status, mirroring `projectEvent`'s LWW upsert guard. */
async function writeReconciledStatus(
	db: Db,
	trackingId: string,
	status: TrackingStatus,
	clock: number
): Promise<void> {
	await db
		.update(tracking)
		.set({ status, statusUpdatedAt: clock, updatedAt: new Date(clock) })
		.where(and(eq(tracking.id, trackingId), sql`${clock} >= ${tracking.statusUpdatedAt}`));
}

/**
 * Recompute one user's show status from the server's own current data and write it back if it
 * moved. Called after `episode.watched`/`unwatched` events are projected — the server's `media`
 * and `episodes` rows (hydrated on the separate media channel) are consulted directly rather than
 * trusting whatever the client happened to have synced locally when it recorded the event, which
 * is what lets this succeed even when the client's own opportunistic reconcile bailed for lack of
 * local per-episode data.
 *
 * `clock` and `now` are deliberately separate: `clock` is the causal LWW clock (the triggering
 * event's `clientCreatedAt`) the write is guarded by, while `now` is the wall-clock instant
 * "aired" is evaluated against — conflating them would misjudge which episodes have aired
 * whenever `clock` isn't close to the real current time (e.g. in tests, or a delayed push).
 */
export async function reconcileUserShowStatus(
	db: Db,
	userId: string,
	mediaId: string,
	clock: number,
	now: number = Date.now()
): Promise<void> {
	const [mediaRow] = await db
		.select({ type: media.type, inProduction: media.inProduction })
		.from(media)
		.where(eq(media.id, mediaId))
		.limit(1);
	if (!mediaRow || mediaRow.type !== 'show') return;

	const episodes = await loadShowEpisodes(db, mediaId);
	const today = todayIso(now);
	const aired = airedEpisodes(episodes, today);
	if (aired.length === 0) return;

	const trackingId = trackingKey(userId, mediaId);
	const [row] = await db
		.select({ status: tracking.status })
		.from(tracking)
		.where(eq(tracking.id, trackingId))
		.limit(1);
	if (!row) return;

	const watchRows = await db
		.select({ season: episodeWatches.season, episode: episodeWatches.episode })
		.from(episodeWatches)
		.where(
			and(
				eq(episodeWatches.userId, userId),
				eq(episodeWatches.mediaId, mediaId),
				eq(episodeWatches.watched, true)
			)
		);
	const watched = new Set(watchRows.map((w) => watchedKey(w.season, w.episode)));
	const watchedCount = aired.filter((e) => watched.has(watchedKey(e.season, e.episode))).length;
	const stillAiring = isStillAiring(episodes, mediaRow.inProduction, today);

	const next = reconciledStatus(row.status, watchedCount, aired.length, stillAiring);
	if (next === null || next === row.status) return;
	await writeReconciledStatus(db, trackingId, next, clock);
}

const RECONCILABLE_STATUSES = ['watching', 'completed'] as const;

/**
 * Recompute every `watching`/`completed` tracker of a show after its episode/production data
 * changed (including data arriving for the first time). Both directions matter here: a `watching`
 * tracker can newly resolve to `completed` once episode data that was missing when they watched
 * finally arrives (the seed-before-metadata case), and a `completed` tracker can be reopened to
 * `watching` by a new season or a still-airing flip. `want_to_watch`/`did_not_finish` trackers are
 * excluded — see the module doc for why they can't need this.
 */
export async function reconcileShowTrackers(db: Db, mediaId: string, now: number): Promise<void> {
	const episodes = await loadShowEpisodes(db, mediaId);
	const today = todayIso(now);
	const aired = airedEpisodes(episodes, today);
	if (aired.length === 0) return;

	const [mediaRow] = await db
		.select({ inProduction: media.inProduction })
		.from(media)
		.where(eq(media.id, mediaId))
		.limit(1);
	const stillAiring = isStillAiring(episodes, mediaRow?.inProduction ?? null, today);

	const trackers = await db
		.select({ id: tracking.id, userId: tracking.userId, status: tracking.status })
		.from(tracking)
		.where(
			and(
				eq(tracking.mediaId, mediaId),
				inArray(tracking.status, [...RECONCILABLE_STATUSES]),
				eq(tracking.removed, false)
			)
		);
	if (trackers.length === 0) return;

	const watchedByUser = new Map<string, Set<string>>();
	const userIds = trackers.map((t) => t.userId);
	for (const ids of chunk(userIds, CHUNK)) {
		const rows = await db
			.select({
				userId: episodeWatches.userId,
				season: episodeWatches.season,
				episode: episodeWatches.episode
			})
			.from(episodeWatches)
			.where(
				and(
					eq(episodeWatches.mediaId, mediaId),
					eq(episodeWatches.watched, true),
					inArray(episodeWatches.userId, ids)
				)
			);
		for (const r of rows) {
			const set = watchedByUser.get(r.userId) ?? new Set<string>();
			set.add(watchedKey(r.season, r.episode));
			watchedByUser.set(r.userId, set);
		}
	}

	for (const t of trackers) {
		const watched = watchedByUser.get(t.userId) ?? new Set<string>();
		const watchedCount = aired.filter((e) => watched.has(watchedKey(e.season, e.episode))).length;
		const next = reconciledStatus(t.status, watchedCount, aired.length, stillAiring);
		if (next !== null && next !== t.status) await writeReconciledStatus(db, t.id, next, now);
	}
}
