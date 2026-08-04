/**
 * Nightly refresh sweep: re-pull every "unsettled" provider-backed title — in-production shows and
 * not-yet-released movies — from TMDB so cached data stays current without a user opening the title.
 * Each goes through the shared {@link refreshMedia}, which skips titles refreshed recently and bumps
 * `version` only when content changed. Invoked by the cron via `POST /api/cron/refresh`.
 */
import { and, eq, gte, isNull } from 'drizzle-orm';
import { media } from '$lib/server/db/schema';
import type { createDb } from '$lib/server/db';
import type { TmdbClient } from '$lib/server/tmdb';
import { refreshMedia } from './hydrate';

type Db = ReturnType<typeof createDb>;

export interface RefreshResult {
	scanned: number;
	changed: number;
	failed: number;
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
		version: media.version
	};
	// Three separate indexed queries, unioned in JS, rather than one `OR`-across-branches query:
	// SQLite/D1 won't reliably plan a single index scan across an OR of different-column
	// predicates, so an unindexed OR here would fall back to a full table scan. Each branch below
	// is a plain equality/range filter that `media_type_in_production_idx` /
	// `media_type_release_date_idx` covers directly.
	const [airingShows, undatedMovies, upcomingMovies] = await Promise.all([
		db
			.select(columns)
			.from(media)
			.where(and(eq(media.type, 'show'), eq(media.inProduction, true))),
		db
			.select(columns)
			.from(media)
			.where(and(eq(media.type, 'movie'), isNull(media.releaseDate))),
		db
			.select(columns)
			.from(media)
			.where(and(eq(media.type, 'movie'), gte(media.releaseDate, today)))
	]);
	const rows = [...airingShows, ...undatedMovies, ...upcomingMovies];

	let changed = 0;
	let failed = 0;
	for (const row of rows) {
		if (!row.externalId) continue; // custom (unlinked) titles can't be hydrated from a provider
		try {
			const updated = await refreshMedia(db, tmdb, row.provider, row.externalId, now, force);
			if (updated && updated.version > row.version) changed++;
		} catch (err) {
			failed++;
			console.error(`cron: failed to refresh ${row.provider}:${row.externalId}`, err);
		}
	}

	return { scanned: rows.length, changed, failed };
}
