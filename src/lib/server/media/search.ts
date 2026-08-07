/**
 * Crowdsourced search fallback (MRQ-90): a substring search over the shared `media` catalog, used
 * when TMDB is unreachable so the search screen degrades to results we already hold rather than
 * going blank. Scoped to provider-backed `linked` rows only — a user's private `custom` entries are
 * never surfaced to other users.
 *
 * SQLite `LIKE` with a leading wildcard can't use a title index, but the shared catalog is bounded
 * and this is a rare fallback path, so a scan is acceptable; an FTS5 table would be the upgrade if it
 * ever gets hot.
 */
import { and, count, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { media, seasons } from '$lib/server/db/schema';
import { SPECIALS_SEASON } from '$lib/tracking/actions';
import type { createDb } from '$lib/server/db';
import type { MediaSearchResult } from '$lib/server/tmdb';

type Db = ReturnType<typeof createDb>;

/** Escape LIKE wildcards in user input so `%` / `_` / `\` match literally (paired with `ESCAPE '\'`). */
function escapeLike(input: string): string {
	return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Case-insensitive title substring search over the shared `linked` catalog, newest-cached first,
 * mapped to the same {@link MediaSearchResult} shape the live TMDB search returns.
 */
export async function searchLinkedMedia(
	db: Db,
	query: string,
	limit = 20
): Promise<MediaSearchResult[]> {
	const q = query.trim();
	if (!q) return [];
	// Fold the query with JS `toLowerCase()` and match the pre-folded `title_normalized` column, so
	// this agrees with the offline client's full-Unicode folding rather than SQLite `LIKE`'s ASCII-only
	// case-insensitivity (MRQ-141). Both operands are already lowercased, so LIKE is a plain substring.
	const pattern = `%${escapeLike(q.toLowerCase())}%`;
	const rows = await db
		.select({
			id: media.id,
			externalId: media.externalId,
			type: media.type,
			title: media.title,
			year: media.year,
			posterPath: media.posterPath,
			inProduction: media.inProduction
		})
		.from(media)
		.where(
			and(
				eq(media.source, 'linked'),
				eq(media.provider, 'tmdb'),
				sql`${media.titleNormalized} LIKE ${pattern} ESCAPE '\\'`
			)
		)
		.orderBy(desc(media.updatedAt))
		.limit(limit);

	const showIds = rows.filter((r) => r.type === 'show').map((r) => r.id);
	// Season counts (excluding Specials), one grouped query for every show row rather than N+1.
	const seasonCounts =
		showIds.length > 0
			? await db
					.select({ mediaId: seasons.mediaId, n: count() })
					.from(seasons)
					.where(and(inArray(seasons.mediaId, showIds), ne(seasons.seasonNumber, SPECIALS_SEASON)))
					.groupBy(seasons.mediaId)
			: [];
	const seasonCountById = new Map(seasonCounts.map((s) => [s.mediaId, s.n]));

	return rows
		.map((r) => ({
			// `linked` tmdb rows carry an `external_id` of `type/tmdbId` (e.g. `movie/603`).
			tmdbId: Number(r.externalId?.split('/')[1]),
			type: r.type,
			title: r.title,
			year: r.year,
			posterPath: r.posterPath,
			overview: '',
			...(r.type === 'show'
				? { numberOfSeasons: seasonCountById.get(r.id) ?? 0, inProduction: r.inProduction }
				: {})
		}))
		.filter((r) => Number.isInteger(r.tmdbId) && r.tmdbId > 0);
}
