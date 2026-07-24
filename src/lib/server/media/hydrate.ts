/**
 * Server-side media hydration for the media channel. The client sends only identity
 * `(provider, externalId)`; the server derives our media id and fetches the metadata from
 * TMDB itself, so the shared `media` catalog only ever holds authoritative data (a client
 * can't inject a title/poster for a shared `linked` row — see the MRQ-111a spec).
 */
import { eq } from 'drizzle-orm';
import { media, type Media } from '$lib/server/db/schema';
import { mediaId, type MediaProvider, type MediaSeason } from '$lib/sync/events';
import type { createDb } from '$lib/server/db';
import type { TmdbClient } from '$lib/server/tmdb';

type Db = ReturnType<typeof createDb>;

/** A TMDB external id (`movie/603`) parsed into its media type and numeric id. */
export interface ParsedTmdbExternalId {
	type: 'movie' | 'show';
	tmdbId: number;
}

/** Parse a TMDB external id (`movie/603`, `show/1396`) into its type + numeric id, or null. */
export function parseTmdbExternalId(externalId: string): ParsedTmdbExternalId | null {
	const match = /^(movie|show)\/(\d+)$/.exec(externalId);
	if (!match) return null;
	return { type: match[1] as 'movie' | 'show', tmdbId: Number(match[2]) };
}

/**
 * Ensure a media row exists for `(provider, externalId)` and return it. Cached: if the row is
 * already stored, returns it without touching TMDB. Returns null for an unknown provider, a
 * malformed external id, or a TMDB miss — so a bad reference simply yields no row.
 */
export async function hydrateMedia(
	db: Db,
	tmdb: Pick<TmdbClient, 'getDetails'>,
	provider: MediaProvider,
	externalId: string
): Promise<Media | null> {
	if (provider !== 'tmdb') return null;
	const parsed = parseTmdbExternalId(externalId);
	if (!parsed) return null;

	const id = mediaId(provider, externalId);
	const cached = await db.select().from(media).where(eq(media.id, id)).limit(1);
	if (cached.length > 0) return cached[0];

	const detail = await tmdb.getDetails(parsed.type, parsed.tmdbId).catch(() => null);
	if (!detail) return null;

	const seasons: MediaSeason[] | null =
		detail.type === 'show'
			? detail.seasons.map((s) => ({ seasonNumber: s.seasonNumber, episodeCount: s.episodeCount }))
			: null;

	// onConflictDoNothing: a concurrent request may have hydrated the same id first.
	await db
		.insert(media)
		.values({
			id,
			provider,
			externalId,
			source: 'linked',
			type: detail.type,
			title: detail.title,
			year: detail.year,
			posterPath: detail.posterPath,
			backdropPath: detail.backdropPath,
			overview: detail.overview,
			seasons
		})
		.onConflictDoNothing();

	const stored = await db.select().from(media).where(eq(media.id, id)).limit(1);
	return stored[0] ?? null;
}
