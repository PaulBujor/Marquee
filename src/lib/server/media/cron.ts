/**
 * Nightly refresh sweep: find every "unsettled" provider-backed title — in-production shows and
 * not-yet-released movies — and enqueue one `MediaRefreshMessage` per title onto the media-refresh
 * queue. Actual hydration happens later, asynchronously, in `refresh-consumer.ts` — this module
 * only selects candidates and enqueues; it never calls TMDB. Cloudflare Queues then invokes the
 * consumer repeatedly, in batches, until the queue drains, which is what replaces the previous
 * one-capped-batch-per-night behavior: the backlog no longer takes multiple nights to clear.
 * Invoked by the cron via `POST /api/cron/refresh`.
 */
import { and, asc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { media } from '$lib/server/db/schema';
import type { createDb } from '$lib/server/db';
import type { QueueProducer } from '$lib/server/queue/types';
import { AIRING_STATUSES } from './hydrate';
import type { MediaRefreshMessage } from './refresh-consumer';

type Db = ReturnType<typeof createDb>;

/**
 * Safety ceiling on how many titles one nightly sweep enqueues. Unlike the old `CRON_REFRESH_MAX`
 * (which bounded TMDB calls + D1 writes made synchronously inside the request), enqueueing is just
 * a D1 read plus cheap queue sends — no TMDB round-trip — so this is a generous backstop against a
 * runaway catalog or a candidate-query bug, not a real budget constraint. Candidates are still
 * ordered oldest-refresh-first, so a capped run's remainder is exactly what the next run picks up.
 */
export const ENQUEUE_MAX = 5000;

export interface EnqueueResult {
	/** Distinct candidates read this run. Itself bounded by the cap, so it is a floor on the real
	 * unsettled population rather than an exact count once `capped` is true. */
	scanned: number;
	/** Titles actually enqueued this run (at most {@link ENQUEUE_MAX}). */
	queued: number;
	/** True when the cap left candidates for the next run. */
	capped: boolean;
}

/**
 * Select every provider-backed, unsettled title — in-production shows, plus movies not yet
 * released (no date, or a date today-or-later) — oldest-refresh-first, and enqueue each as a
 * `MediaRefreshMessage`. `force` is carried onto every enqueued message so the consumer bypasses
 * `refreshMedia`'s TTL (a manual re-hydrate); `now` and `max` are injectable for tests.
 */
export async function enqueueStaleMedia(
	db: Db,
	queue: QueueProducer<MediaRefreshMessage>,
	now: number = Date.now(),
	force = false,
	max: number = ENQUEUE_MAX
): Promise<EnqueueResult> {
	const today = new Date(now).toISOString().slice(0, 10);
	const columns = {
		id: media.id,
		provider: media.provider,
		externalId: media.externalId,
		refreshedAt: media.refreshedAt
	};
	// Three separate indexed queries, unioned in JS, rather than one `OR`-across-branches query:
	// SQLite/D1 won't reliably plan a single index scan across an OR of different-column
	// predicates, so an unindexed OR here would fall back to a full table scan. Each branch below
	// is a plain equality/range filter that `media_type_in_production_idx` /
	// `media_type_release_date_idx` covers directly.
	// Each branch is limited, not just the merged result: an unbounded SELECT would pull the whole
	// matching population into Worker memory before the cap could apply, so a runaway catalog (or a
	// candidate-query bug) would blow the read up exactly where the ceiling is supposed to protect
	// it. Every branch is ordered oldest-refresh-first, so taking the first `max` per branch still
	// leaves the `max` oldest overall in the merged set. The `+ 1` is what makes overflow visible —
	// reading exactly `max` can't distinguish "that's all of them" from "there are more".
	const [airingShows, betweenSeasonShows, undatedMovies, upcomingMovies] = await Promise.all([
		db
			.select(columns)
			.from(media)
			.where(and(eq(media.type, 'show'), eq(media.inProduction, true)))
			.orderBy(asc(media.refreshedAt))
			.limit(max + 1),
		// `in_production` alone misses a show between seasons, where TMDB has already flipped it
		// false but the status still says more is coming. That is exactly the case `needsRefresh`
		// covers via AIRING_STATUSES, and exactly the case users are waiting on a new season for —
		// so the sweep has to match the same rule, not a narrower one.
		db
			.select(columns)
			.from(media)
			.where(and(eq(media.type, 'show'), inArray(media.status, [...AIRING_STATUSES])))
			.orderBy(asc(media.refreshedAt))
			.limit(max + 1),
		db
			.select(columns)
			.from(media)
			.where(and(eq(media.type, 'movie'), isNull(media.releaseDate)))
			.orderBy(asc(media.refreshedAt))
			.limit(max + 1),
		db
			.select(columns)
			.from(media)
			.where(and(eq(media.type, 'movie'), gte(media.releaseDate, today)))
			.orderBy(asc(media.refreshedAt))
			.limit(max + 1)
	]);

	// The two show queries overlap (in-production *and* an airing status is the common case), so
	// dedupe by id before counting or enqueueing.
	type Candidate = (typeof airingShows)[number] & { externalId: string };
	const byId = new Map<string, Candidate>();
	for (const row of [...airingShows, ...betweenSeasonShows, ...undatedMovies, ...upcomingMovies]) {
		// Custom (unlinked) titles can't be hydrated from a provider.
		if (row.externalId === null || byId.has(row.id)) continue;
		byId.set(row.id, { ...row, externalId: row.externalId });
	}
	// Oldest refresh first, so a capped run resumes where the previous one stopped.
	const candidates = [...byId.values()].sort((a, b) => a.refreshedAt - b.refreshedAt);
	const batch = candidates.slice(0, max);
	const capped = candidates.length > batch.length;
	if (capped) {
		console.warn(
			`cron: at least ${candidates.length} unsettled titles, enqueueing ${batch.length} this run (oldest first)`
		);
	}

	const messages: MediaRefreshMessage[] = batch.map((row) => ({
		provider: row.provider,
		externalId: row.externalId,
		...(force ? { force: true as const } : {})
	}));
	await queue.enqueueBatch(messages);

	return { scanned: candidates.length, queued: batch.length, capped };
}
