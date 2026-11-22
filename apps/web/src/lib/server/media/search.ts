/** Fallback when TMDB is unreachable: `linked` rows only — a private `custom` entry is never surfaced to other users. */
import { and, desc, eq, sql } from 'drizzle-orm';
import { media } from '#lib/server/db/schema.js';
import type { createDb } from '#lib/server/db/index.js';
import type { MediaSearchResult } from '#lib/server/tmdb/index.js';

type Db = ReturnType<typeof createDb>;

/** Escape LIKE wildcards so `%` / `_` / `\` match literally (paired with `ESCAPE '\'`). */
function escapeLike(input: string): string {
	return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function searchLinkedMedia(
	db: Db,
	query: string,
	limit = 20
): Promise<MediaSearchResult[]> {
	const q = query.trim();
	if (!q) return [];
	// Match the pre-folded `title_normalized` with JS `toLowerCase()`, so this agrees with the offline client's full-Unicode folding rather than SQLite `LIKE`'s ASCII-only case-insensitivity.
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
