import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import type { createDb } from '#lib/server/db/index.js';
import {
	episodeWatches,
	events,
	media,
	tracking,
	users,
	type UserStatus
} from '#lib/server/db/schema.js';

type Db = ReturnType<typeof createDb>;

export type StatusCounts = Record<UserStatus, number>;

const EMPTY: StatusCounts = { pending: 0, enabled: 0, blocked: 0 };

export async function countUsersByStatus(db: Db): Promise<StatusCounts> {
	const rows = await db
		.select({ status: users.status, total: sql<number>`count(*)` })
		.from(users)
		.groupBy(users.status);

	const counts: StatusCounts = { ...EMPTY };
	for (const row of rows) counts[row.status] = Number(row.total);
	return counts;
}

export interface UsageMetrics {
	movies: number;
	shows: number;
	watched: number;
	favourites: number;
	rated: number;
	episodesWatched: number;
	activeWeek: number;
	activeMonth: number;
	growth: { week: string; added: number }[];
	topTitles: { id: string; title: string; trackers: number }[];
}

/** Counts over existing tables only — no rollup, no new write path. `removed` rows are tombstones, not live data. */
export async function countUsage(db: Db, now = new Date()): Promise<UsageMetrics> {
	const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
	const monthAgo = new Date(now.getTime() - 30 * 86_400_000);
	const weeksAgo = new Date(now.getTime() - 8 * 7 * 86_400_000);
	const live = eq(tracking.removed, false);

	const [types, watched, favourites, rated, episodes, week, month, growth, top] = await Promise.all(
		[
			db
				.select({ type: media.type, total: sql<number>`count(*)` })
				.from(tracking)
				.innerJoin(media, eq(tracking.mediaId, media.id))
				.where(live)
				.groupBy(media.type),
			db
				.select({ total: sql<number>`count(*)` })
				.from(tracking)
				.where(and(live, eq(tracking.status, 'completed'))),
			db
				.select({ total: sql<number>`count(*)` })
				.from(tracking)
				.where(and(live, eq(tracking.favorite, true))),
			db
				.select({ total: sql<number>`count(*)` })
				.from(tracking)
				.where(and(live, isNotNull(tracking.rating))),
			db
				.select({ total: sql<number>`count(*)` })
				.from(episodeWatches)
				.where(eq(episodeWatches.watched, true)),
			db
				.select({ total: sql<number>`count(distinct ${events.userId})` })
				.from(events)
				.where(gte(events.serverReceivedAt, weekAgo)),
			db
				.select({ total: sql<number>`count(distinct ${events.userId})` })
				.from(events)
				.where(gte(events.serverReceivedAt, monthAgo)),
			db
				.select({
					week: sql<string>`strftime('%Y-%W', ${tracking.addedAt}, 'unixepoch')`,
					added: sql<number>`count(*)`
				})
				.from(tracking)
				.where(and(live, gte(tracking.addedAt, weeksAgo)))
				.groupBy(sql`1`)
				.orderBy(sql`1`),
			db
				.select({ id: media.id, title: media.title, trackers: sql<number>`count(*)` })
				.from(tracking)
				.innerJoin(media, eq(tracking.mediaId, media.id))
				.where(live)
				.groupBy(media.id, media.title)
				.orderBy(desc(sql`count(*)`))
				.limit(5)
		]
	);

	const byType = new Map(types.map((row) => [row.type, Number(row.total)]));

	return {
		movies: byType.get('movie') ?? 0,
		shows: byType.get('show') ?? 0,
		watched: Number(watched[0]?.total ?? 0),
		favourites: Number(favourites[0]?.total ?? 0),
		rated: Number(rated[0]?.total ?? 0),
		episodesWatched: Number(episodes[0]?.total ?? 0),
		activeWeek: Number(week[0]?.total ?? 0),
		activeMonth: Number(month[0]?.total ?? 0),
		growth: growth.map((row) => ({ week: row.week, added: Number(row.added) })),
		topTitles: top.map((row) => ({
			id: row.id,
			title: row.title,
			trackers: Number(row.trackers)
		}))
	};
}
