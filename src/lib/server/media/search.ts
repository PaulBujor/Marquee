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

/** Season counts (excluding Specials) for a batch of media ids, one grouped query rather than N+1. */
async function seasonCountsByMediaId(db: Db, mediaIds: string[]): Promise<Map<string, number>> {
	if (mediaIds.length === 0) return new Map();
	const rows = await db
		.select({ mediaId: seasons.mediaId, n: count() })
		.from(seasons)
		.where(and(inArray(seasons.mediaId, mediaIds), ne(seasons.seasonNumber, SPECIALS_SEASON)))
		.groupBy(seasons.mediaId);
	return new Map(rows.map((r) => [r.mediaId, r.n]));
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

	const showIds = rows.filter((r) => r.type === 'show').map((r) => r.id);
	const seasonCountById = await seasonCountsByMediaId(db, showIds);

	return rows
		.map((r) => ({
			// `linked` tmdb rows carry an `external_id` of `type/tmdbId` (e.g. `movie/603`).
			tmdbId: Number(r.externalId?.split('/')[1]),
			type: r.type,
			title: r.title,
			year: r.year,
			posterPath: r.posterPath,
			overview: '',
			...(r.type === 'show' ? { numberOfSeasons: seasonCountById.get(r.id) ?? 0 } : {})
		}))
		.filter((r) => Number.isInteger(r.tmdbId) && r.tmdbId > 0);
}

/**
 * Fill in season count on live TMDB search results (MRQ-209) for any show we already hold a
 * `linked` copy of — TMDB's `/search/multi` endpoint doesn't return it itself, and fetching
 * per-result details would mean an extra TMDB call per row on every keystroke. A title neither
 * this nor any other user has opened/tracked before still won't carry a season count on first
 * search; it fills in once someone views it (the catalog is shared across all users, see
 * `source: 'linked'`). Movies are returned unchanged — the field is shows-only.
 */
export async function enrichWithLinkedData(
	db: Db,
	results: MediaSearchResult[]
): Promise<MediaSearchResult[]> {
	const externalIds = results.filter((r) => r.type === 'show').map((r) => `show/${r.tmdbId}`);
	if (externalIds.length === 0) return results;

	const rows = await db
		.select({ id: media.id, externalId: media.externalId })
		.from(media)
		.where(
			and(
				eq(media.source, 'linked'),
				eq(media.provider, 'tmdb'),
				inArray(media.externalId, externalIds)
			)
		);
	if (rows.length === 0) return results;

	const seasonCountById = await seasonCountsByMediaId(
		db,
		rows.map((r) => r.id)
	);
	const byExternalId = new Map(
		rows.map((r) => [r.externalId, { numberOfSeasons: seasonCountById.get(r.id) ?? 0 }])
	);

	return results.map((r) => {
		if (r.type !== 'show') return r;
		const match = byExternalId.get(`show/${r.tmdbId}`);
		return match ? { ...r, ...match } : r;
	});
}
