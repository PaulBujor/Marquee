/**
 * Server-side media hydration for the media channel + the nightly refresh cron. The client sends
 * only identity `(provider, externalId)`; the server derives our media id and fetches metadata from
 * TMDB, so the shared catalog only ever holds authoritative data — a client can't inject a
 * title/poster for a shared `linked` row.
 *
 * `refreshMedia` is refresh-aware: on a miss it fully hydrates (details + every season's episodes);
 * on a hit it re-pulls only when the row is stale (airing shows past a TTL; movies + finished shows
 * never), reconciles the `seasons`/`episodes` child rows, and bumps `version` only when content
 * actually changed.
 */
import { eq } from 'drizzle-orm';
import { episodes, media, seasons, type EpisodeRow, type Media } from '$lib/server/db/schema';
import { mediaId, type MediaProvider } from '$lib/sync/events';
import type { createDb } from '$lib/server/db';
import type { MediaDetail, SeasonDetail, TmdbClient } from '$lib/server/tmdb';

type Db = ReturnType<typeof createDb>;
type TmdbHydrator = Pick<TmdbClient, 'getDetails' | 'getSeason'>;

/** How long a still-airing show's cache is trusted before a re-pull (12h). */
export const AIRING_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * D1 caps bound parameters per query at 100, so multi-row inserts must be chunked to stay under it
 * — a 50-row episode insert is 400 params and fails on D1 (better-sqlite3 in tests has no such cap,
 * so it doesn't surface there). Chunk size is derived per table from its column count.
 */
const D1_MAX_BOUND_PARAMS = 100;

function chunkForD1<T extends object>(rows: T[]): T[][] {
	if (rows.length === 0) return [];
	const paramsPerRow = Object.keys(rows[0]).length;
	const size = Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / paramsPerRow));
	const chunks: T[][] = [];
	for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));
	return chunks;
}

// TMDB's own TV statuses (full set: Returning Series / Planned / In Production / Ended / Canceled /
// Pilot) for a show that may still gain episodes. `in_production` is the primary signal; these catch
// a show between seasons where `in_production` has flipped false but more is expected.
const AIRING_STATUSES = new Set(['Returning Series', 'In Production', 'Planned', 'Pilot']);

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
 * Whether a stored row should be re-pulled from TMDB. A `refreshed_at` of 0 marks a row that
 * predates the relational model (migration backfill) — always refresh it once to populate
 * seasons/episodes. Otherwise movies + finished shows never change; only airing shows refresh,
 * and only past the TTL.
 */
export function needsRefresh(row: Media, now: number): boolean {
	if (row.refreshedAt === 0) return true;
	if (row.type !== 'show') return false;
	const airing = row.inProduction === true || AIRING_STATUSES.has(row.status ?? '');
	return airing && now - row.refreshedAt > AIRING_TTL_MS;
}

/** Stable signature of the episode set (coords + air dates) to detect content changes. */
function episodeSignature(
	rows: { seasonNumber: number; episodeNumber: number; airDate: string | null }[]
): string {
	return rows
		.map((e) => `${e.seasonNumber}:${e.episodeNumber}:${e.airDate ?? ''}`)
		.sort()
		.join('|');
}

/** Map a normalized TMDB detail (+ fetched season details) to the media/seasons/episodes rows. */
function toRows(
	id: string,
	provider: MediaProvider,
	externalId: string,
	detail: MediaDetail,
	seasonDetails: SeasonDetail[]
) {
	const scalars = {
		id,
		provider,
		externalId,
		type: detail.type,
		title: detail.title,
		year: detail.year,
		posterPath: detail.posterPath,
		backdropPath: detail.backdropPath,
		overview: detail.overview,
		genres: detail.genres,
		releaseDate: detail.releaseDate,
		status: detail.status,
		inProduction: detail.inProduction,
		firstAirDate: detail.firstAirDate,
		lastAirDate: detail.lastAirDate
	};
	const seasonRows = detail.seasons.map((s) => ({
		mediaId: id,
		seasonNumber: s.seasonNumber,
		name: s.name,
		overview: s.overview,
		airDate: s.airDate,
		posterPath: s.posterPath,
		episodeCount: s.episodeCount
	}));
	const episodeRows = seasonDetails.flatMap((sd) =>
		sd.episodes.map((e) => ({
			mediaId: id,
			seasonNumber: sd.seasonNumber,
			episodeNumber: e.episodeNumber,
			name: e.name,
			overview: e.overview,
			airDate: e.airDate,
			runtime: e.runtime,
			stillPath: e.stillPath
		}))
	);
	return { scalars, seasonRows, episodeRows };
}

async function replaceChildren(
	db: Db,
	id: string,
	seasonRows: (typeof seasons.$inferInsert)[],
	episodeRows: (typeof episodes.$inferInsert)[]
): Promise<void> {
	await db.delete(episodes).where(eq(episodes.mediaId, id));
	await db.delete(seasons).where(eq(seasons.mediaId, id));
	for (const chunk of chunkForD1(seasonRows)) await db.insert(seasons).values(chunk);
	for (const chunk of chunkForD1(episodeRows)) await db.insert(episodes).values(chunk);
}

/**
 * Ensure a fresh media row (+ its seasons/episodes) exists for `(provider, externalId)` and return
 * it. Cached + TTL-aware: an up-to-date row is returned without touching TMDB. Returns null for an
 * unknown provider / malformed id / first-time TMDB miss (a transient miss on an existing row keeps
 * the stored data). `now` is injectable for tests.
 */
export async function refreshMedia(
	db: Db,
	tmdb: TmdbHydrator,
	provider: MediaProvider,
	externalId: string,
	now: number = Date.now()
): Promise<Media | null> {
	if (provider !== 'tmdb') return null;
	const parsed = parseTmdbExternalId(externalId);
	if (!parsed) return null;

	const id = mediaId(provider, externalId);
	const existingRows = await db.select().from(media).where(eq(media.id, id)).limit(1);
	const existing = existingRows[0] ?? null;
	if (existing && !needsRefresh(existing, now)) return existing;

	const detail = await tmdb.getDetails(parsed.type, parsed.tmdbId).catch(() => null);
	// A transient TMDB miss shouldn't wipe an existing row — keep what we have.
	if (!detail) return existing;

	// Fetch every season's episodes (incl. Specials) so per-episode air dates persist.
	const seasonDetails =
		detail.type === 'show'
			? (
					await Promise.all(
						detail.seasons.map((s) =>
							tmdb.getSeason(parsed.tmdbId, s.seasonNumber).catch(() => null)
						)
					)
				).filter((s): s is SeasonDetail => s !== null)
			: [];

	const { scalars, seasonRows, episodeRows } = toRows(
		id,
		provider,
		externalId,
		detail,
		seasonDetails
	);

	if (!existing) {
		await db
			.insert(media)
			.values({ ...scalars, source: 'linked', version: 1, refreshedAt: now })
			.onConflictDoNothing();
		if (detail.type === 'show') await replaceChildren(db, id, seasonRows, episodeRows);
	} else {
		const oldEpisodes: Pick<EpisodeRow, 'seasonNumber' | 'episodeNumber' | 'airDate'>[] = await db
			.select({
				seasonNumber: episodes.seasonNumber,
				episodeNumber: episodes.episodeNumber,
				airDate: episodes.airDate
			})
			.from(episodes)
			.where(eq(episodes.mediaId, id));
		const changed =
			existing.title !== scalars.title ||
			existing.status !== scalars.status ||
			existing.inProduction !== scalars.inProduction ||
			existing.lastAirDate !== scalars.lastAirDate ||
			existing.releaseDate !== scalars.releaseDate ||
			episodeSignature(oldEpisodes) !== episodeSignature(episodeRows);
		// Write the children first: if that throws, the media row keeps its old `refreshedAt`, so the
		// next sync retries — rather than being stamped fresh-but-empty and never refreshing again.
		if (detail.type === 'show') await replaceChildren(db, id, seasonRows, episodeRows);
		await db
			.update(media)
			.set({
				...scalars,
				// Preserve the source (a linked row stays linked) and the event↔media LWW clock.
				source: existing.source,
				updatedAt: existing.updatedAt,
				refreshedAt: now,
				version: changed ? existing.version + 1 : existing.version
			})
			.where(eq(media.id, id));
	}

	const stored = await db.select().from(media).where(eq(media.id, id)).limit(1);
	return stored[0] ?? null;
}
