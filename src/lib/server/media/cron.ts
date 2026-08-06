/**
 * Nightly refresh sweep: re-pull every "unsettled" provider-backed title — in-production shows and
 * not-yet-released movies — from TMDB so cached data stays current without a user opening the title.
 * Each goes through the shared {@link refreshMedia}, which skips titles refreshed recently and bumps
 * `version` only when content changed. Invoked by the cron via `POST /api/cron/refresh`.
 */
import { and, asc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { media } from '$lib/server/db/schema';
import type { createDb } from '$lib/server/db';
import type { TmdbClient } from '$lib/server/tmdb';
import { AIRING_STATUSES, refreshMedia } from './hydrate';

type Db = ReturnType<typeof createDb>;

/**
 * Max titles refreshed in one sweep. Each show costs a TMDB detail call plus one per season, so an
 * unbounded pass over a growing catalog eventually exceeds the Worker's CPU/subrequest budget and
 * aborts partway — always at the same place, leaving the tail permanently stale. Candidates are
 * ordered oldest-refresh-first, so consecutive nightly runs walk the whole catalog instead of
 * replaying its head.
 */
export const CRON_REFRESH_MAX = 200;

export interface RefreshResult {
	/** Candidates matched by the staleness query, before the per-run cap. */
	scanned: number;
	/** Titles actually put through `refreshMedia` this run (at most {@link CRON_REFRESH_MAX}). */
	attempted: number;
	changed: number;
	failed: number;
	/** True when the cap left candidates for the next run. */
	capped: boolean;
}

/**
 * Refresh all provider-backed, unsettled titles: in-production shows, plus movies not yet released
 * (no date, or a date today-or-later). Per-title failures are isolated so one bad title
 * can't abort the run; `refreshMedia`'s TTL still gates each. `force` bypasses that TTL (for a manual
 * re-hydrate); `now` is injectable for tests.
 */
export async function refreshStaleMedia(
	db: Db,
	tmdb: Pick<TmdbClient, 'getDetails' | 'getSeason'>,
	now: number = Date.now(),
	force = false
): Promise<RefreshResult> {
	const today = new Date(now).toISOString().slice(0, 10);
	const columns = {
		id: media.id,
		provider: media.provider,
		externalId: media.externalId,
		version: media.version,
		refreshedAt: media.refreshedAt
	};
	// Three separate indexed queries, unioned in JS, rather than one `OR`-across-branches query:
	// SQLite/D1 won't reliably plan a single index scan across an OR of different-column
	// predicates, so an unindexed OR here would fall back to a full table scan. Each branch below
	// is a plain equality/range filter that `media_type_in_production_idx` /
	// `media_type_release_date_idx` covers directly.
	const [airingShows, betweenSeasonShows, undatedMovies, upcomingMovies] = await Promise.all([
		db
			.select(columns)
			.from(media)
			.where(and(eq(media.type, 'show'), eq(media.inProduction, true)))
			.orderBy(asc(media.refreshedAt)),
		// `in_production` alone misses a show between seasons, where TMDB has already flipped it
		// false but the status still says more is coming. That is exactly the case `needsRefresh`
		// covers via AIRING_STATUSES, and exactly the case users are waiting on a new season for —
		// so the sweep has to match the same rule, not a narrower one.
		db
			.select(columns)
			.from(media)
			.where(and(eq(media.type, 'show'), inArray(media.status, [...AIRING_STATUSES])))
			.orderBy(asc(media.refreshedAt)),
		db
			.select(columns)
			.from(media)
			.where(and(eq(media.type, 'movie'), isNull(media.releaseDate)))
			.orderBy(asc(media.refreshedAt)),
		db
			.select(columns)
			.from(media)
			.where(and(eq(media.type, 'movie'), gte(media.releaseDate, today)))
			.orderBy(asc(media.refreshedAt))
	]);

	// The two show queries overlap (in-production *and* an airing status is the common case), so
	// dedupe by id before counting or refreshing.
	type Candidate = (typeof airingShows)[number] & { externalId: string };
	const byId = new Map<string, Candidate>();
	for (const row of [...airingShows, ...betweenSeasonShows, ...undatedMovies, ...upcomingMovies]) {
		// Custom (unlinked) titles can't be hydrated from a provider.
		if (row.externalId === null || byId.has(row.id)) continue;
		byId.set(row.id, { ...row, externalId: row.externalId });
	}
	// Oldest refresh first, so a capped run resumes where the previous one stopped.
	const candidates = [...byId.values()].sort((a, b) => a.refreshedAt - b.refreshedAt);
	const batch = candidates.slice(0, CRON_REFRESH_MAX);
	const capped = candidates.length > batch.length;
	if (capped) {
		console.warn(
			`cron: ${candidates.length} unsettled titles, refreshing ${batch.length} this run (oldest first)`
		);
	}

	let changed = 0;
	let failed = 0;
	for (const row of batch) {
		try {
			const updated = await refreshMedia(db, tmdb, row.provider, row.externalId, now, force);
			if (updated && updated.version > row.version) changed++;
		} catch (err) {
			failed++;
			console.error(`cron: failed to refresh ${row.provider}:${row.externalId}`, err);
		}
	}

	return { scanned: candidates.length, attempted: batch.length, changed, failed, capped };
}
