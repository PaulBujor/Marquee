/**
 * Crowdsourced search fallback: a substring search over the shared `media` catalog, used
 * when TMDB is unreachable so the search screen degrades to results we already hold rather than
 * going blank. Scoped to provider-backed `linked` rows only — a user's private `custom` entries are
 * never surfaced to other users.
 *
 * SQLite `LIKE` with a leading wildcard can't use a title index, but the shared catalog is bounded
 * and this is a rare fallback path, so a scan is acceptable; an FTS5 table would be the upgrade if it
 * ever gets hot.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { media } from '$lib/server/db/schema';
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
	// case-insensitivity. Both operands are already lowercased, so LIKE is a plain substring.
	const pattern = `%${escapeLike(q.toLowerCase())}%`;
	const rows = await db
		.select({
			externalId: media.externalId,
			type: media.type,
			title: media.title,
			year: media.year,
			posterPath: media.posterPath
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

	return rows
		.map((r) => ({
			// `linked` tmdb rows carry an `external_id` of `type/tmdbId` (e.g. `movie/603`).
			tmdbId: Number(r.externalId?.split('/')[1]),
			type: r.type,
			title: r.title,
			year: r.year,
			posterPath: r.posterPath,
			overview: ''
		}))
		.filter((r) => Number.isInteger(r.tmdbId) && r.tmdbId > 0);
}
