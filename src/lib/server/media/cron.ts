/**
 * Nightly refresh sweep: re-pull every in-production show from TMDB so cached seasons/episodes/air
 * dates stay current without a user opening the title. Each show goes through the shared
 * {@link refreshMedia}, which skips titles refreshed recently and bumps `version` only when content
 * changed. Invoked by the cron via `POST /api/cron/refresh`.
 */
import { and, eq } from 'drizzle-orm';
import { media } from '$lib/server/db/schema';
import type { createDb } from '$lib/server/db';
import type { TmdbClient } from '$lib/server/tmdb';
import { refreshMedia } from './hydrate';

type Db = ReturnType<typeof createDb>;

export interface RefreshResult {
	scanned: number;
	changed: number;
}

/**
 * Refresh all provider-backed, in-production shows. Per-show failures are isolated (logged, the
 * sweep continues) so one bad title can't abort the run. `now` is injectable for tests.
 */
export async function refreshInProductionShows(
	db: Db,
	tmdb: Pick<TmdbClient, 'getDetails' | 'getSeason'>,
	now: number = Date.now()
): Promise<RefreshResult> {
	const rows = await db
		.select({
			id: media.id,
			provider: media.provider,
			externalId: media.externalId,
			version: media.version
		})
		.from(media)
		.where(and(eq(media.type, 'show'), eq(media.inProduction, true)));

	let changed = 0;
	for (const row of rows) {
		if (!row.externalId) continue; // custom (unlinked) shows can't be hydrated from a provider
		try {
			const updated = await refreshMedia(db, tmdb, row.provider, row.externalId, now);
			if (updated && updated.version > row.version) changed++;
		} catch (err) {
			console.error(`cron: failed to refresh ${row.provider}:${row.externalId}`, err);
		}
	}

	return { scanned: rows.length, changed };
}
