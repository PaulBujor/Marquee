/** Only selects and enqueues — never calls TMDB; Cloudflare Queues drains the backlog in batches. */
import { and, asc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { media } from '#lib/server/db/schema.js';
import type { createDb } from '#lib/server/db/index.js';
import type { QueueProducer } from '#lib/server/queue/types.js';
import { AIRING_STATUSES } from './hydrate';
import type { MediaRefreshMessage } from './refresh-consumer';

type Db = ReturnType<typeof createDb>;

/** A generous backstop, not a budget: enqueueing is a D1 read plus cheap queue sends, no TMDB round-trip. */
export const ENQUEUE_MAX = 5000;

export interface EnqueueResult {
	/** Bounded by the cap, so a floor on the real population once `capped` is true. */
	scanned: number;
	queued: number;
	capped: boolean;
}

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
	// Three separate indexed queries rather than one OR across branches: D1 won't reliably plan a single index scan over an OR of different-column predicates.
	// Limit per branch, not just the merged result — an unbounded SELECT pulls the whole catalog into Worker memory; the `+ 1` makes overflow distinguishable from exhaustion.
	const [airingShows, betweenSeasonShows, undatedMovies, upcomingMovies] = await Promise.all([
		db
			.select(columns)
			.from(media)
			.where(and(eq(media.type, 'show'), eq(media.inProduction, true)))
			.orderBy(asc(media.refreshedAt))
			.limit(max + 1),
		// `in_production` alone misses a between-seasons show, so the sweep has to match `needsRefresh`'s AIRING_STATUSES rule.
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

	// The two show queries overlap, so dedupe by id before counting or enqueueing.
	type Candidate = (typeof airingShows)[number] & { externalId: string };
	const byId = new Map<string, Candidate>();
	for (const row of [...airingShows, ...betweenSeasonShows, ...undatedMovies, ...upcomingMovies]) {
		// Custom (unlinked) titles can't be hydrated from a provider.
		if (row.externalId === null || byId.has(row.id)) continue;
		byId.set(row.id, { ...row, externalId: row.externalId });
	}
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
