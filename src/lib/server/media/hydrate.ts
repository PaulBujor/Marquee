/**
 * Server-side media hydration for the media channel + the nightly refresh cron. The client sends
 * only identity `(provider, externalId)`; the server derives our media id and fetches metadata from
 * TMDB, so the shared catalog only ever holds authoritative data — a client can't inject a
 * title/poster for a shared `linked` row.
 *
 * `refreshMedia` is refresh-aware: on a miss it fully hydrates (details + every season's episodes);
 * on a hit it re-pulls only when the row is stale (airing shows past a TTL; movies + finished shows
 * never), diffs the `seasons`/`episodes` child rows against what's stored and writes only what
 * actually changed, and bumps `version` only when content actually changed.
 *
 * The child-row reconcilers (`syncSeasons` / `syncEpisodes`) and the content signatures are
 * exported because they aren't TMDB-specific: storing a user-authored show needs exactly the same
 * diff-and-write against `seasons`/`episodes` (see `./custom`).
 */
import { and, eq, or, sql } from 'drizzle-orm';
import {
	episodes,
	media,
	seasons,
	type EpisodeRow,
	type Media,
	type SeasonRow
} from '$lib/server/db/schema';
import { chunkBySize, chunkRows, D1_MAX_BOUND_PARAMS } from '$lib/server/db/chunk';
import { hasDescription } from '$lib/media';
import { mediaId, type MediaProvider } from '$lib/sync/events';
import type { createDb } from '$lib/server/db';
import type { MediaDetail, SeasonDetail, TmdbClient } from '$lib/server/tmdb';

type Db = ReturnType<typeof createDb>;
type TmdbHydrator = Pick<TmdbClient, 'getDetails' | 'getSeason'>;

/** How long an unsettled title's cache (airing show / unreleased movie) is trusted before a re-pull (12h). */
export const AIRING_TTL_MS = 12 * 60 * 60 * 1000;

// TMDB's own TV statuses (full set: Returning Series / Planned / In Production / Ended / Canceled /
// Pilot) for a show that may still gain episodes. `in_production` is the primary signal; these catch
// a show between seasons where `in_production` has flipped false but more is expected.
export const AIRING_STATUSES = ['Returning Series', 'In Production', 'Planned', 'Pilot'] as const;
const AIRING_STATUS_SET = new Set<string>(AIRING_STATUSES);

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
 * Whether a movie hasn't released yet, so it should keep refreshing (release date + metadata can
 * still change). TMDB gives a full date or nothing; a missing/uncertain date is treated as end of
 * the current year — a concrete horizon to refresh toward. A movie whose date is in the
 * past has released and never refreshes again.
 */
function movieUnreleased(releaseDate: string | null, now: number): boolean {
	const today = new Date(now).toISOString().slice(0, 10);
	const horizon = releaseDate ?? `${new Date(now).getUTCFullYear()}-12-31`;
	return horizon >= today;
}

/**
 * Whether a stored row should be re-pulled from TMDB. A `refreshed_at` of 0 marks a row that
 * predates the relational model (migration backfill) — always refresh it once to populate
 * seasons/episodes. Otherwise, past the TTL: airing shows refresh, and **unreleased movies** refresh
 * released movies and finished shows never change, so they don't.
 */
export function needsRefresh(row: Media, now: number): boolean {
	if (row.refreshedAt === 0) return true;
	if (now - row.refreshedAt <= AIRING_TTL_MS) return false;
	if (row.type === 'movie') return movieUnreleased(row.releaseDate, now);
	return row.inProduction === true || AIRING_STATUS_SET.has(row.status ?? '');
}

export type SeasonInsert = typeof seasons.$inferInsert;
export type EpisodeInsert = typeof episodes.$inferInsert;

/** Mutable (non-key) columns compared to decide whether a row needs (re)writing. */
const SEASON_CONTENT_FIELDS = [
	'name',
	'overview',
	'airDate',
	'posterPath',
	'episodeCount'
] as const;
const EPISODE_CONTENT_FIELDS = ['name', 'overview', 'airDate', 'runtime', 'stillPath'] as const;

function contentChanged<K extends string>(
	a: Record<K, unknown>,
	b: Partial<Record<K, unknown>>,
	fields: readonly K[]
): boolean {
	return fields.some((f) => a[f] !== b[f]);
}

/** Stable signature of a season set (coords + every mutable field) to detect content changes. */
export function seasonSignature(
	rows: Pick<SeasonInsert, (typeof SEASON_CONTENT_FIELDS)[number] | 'seasonNumber'>[]
): string {
	return rows
		.map((s) =>
			[
				s.seasonNumber,
				s.name,
				s.overview,
				s.airDate ?? '',
				s.posterPath ?? '',
				s.episodeCount
			].join(':')
		)
		.sort()
		.join('|');
}

/** Stable signature of an episode set (coords + every mutable field) to detect content changes. */
export function episodeSignature(
	rows: Pick<
		EpisodeInsert,
		(typeof EPISODE_CONTENT_FIELDS)[number] | 'seasonNumber' | 'episodeNumber'
	>[]
): string {
	return rows
		.map((e) =>
			[
				e.seasonNumber,
				e.episodeNumber,
				e.name,
				e.overview,
				e.airDate ?? '',
				e.runtime ?? '',
				e.stillPath ?? ''
			].join(':')
		)
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
		// Fold with JS `toLowerCase()` so the degraded search matches the offline client's folding
		// (full Unicode), not SQLite's ASCII-only `LIKE`.
		titleNormalized: detail.title.toLowerCase(),
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
	// The show-detail summary's overview is often blank; the season endpoint's is the real synopsis.
	const seasonOverviewByNumber = new Map(seasonDetails.map((sd) => [sd.seasonNumber, sd.overview]));
	const seasonRows = detail.seasons.map((s) => {
		const detailOverview = seasonOverviewByNumber.get(s.seasonNumber) ?? '';
		return {
			mediaId: id,
			seasonNumber: s.seasonNumber,
			name: s.name,
			overview: hasDescription(detailOverview) ? detailOverview : s.overview,
			airDate: s.airDate,
			posterPath: s.posterPath,
			episodeCount: s.episodeCount
		};
	});
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

/**
 * Reconcile a show's stored seasons against freshly-fetched ones: upsert rows that are new or whose
 * content differs, delete rows that disappeared (or were renumbered away from), and leave every
 * unchanged row untouched — a genuinely unchanged season set issues zero queries.
 */
export async function syncSeasons(
	db: Db,
	id: string,
	oldRows: SeasonRow[],
	newRows: SeasonInsert[]
): Promise<void> {
	const oldByNumber = new Map(oldRows.map((r) => [r.seasonNumber, r]));
	const newNumbers = new Set(newRows.map((r) => r.seasonNumber));

	const toUpsert = newRows.filter((r) => {
		const old = oldByNumber.get(r.seasonNumber);
		return !old || contentChanged(old, r, SEASON_CONTENT_FIELDS);
	});
	const toDelete = oldRows.filter((r) => !newNumbers.has(r.seasonNumber));

	for (const chunk of chunkRows(toUpsert)) {
		await db
			.insert(seasons)
			.values(chunk)
			.onConflictDoUpdate({
				target: [seasons.mediaId, seasons.seasonNumber],
				set: {
					name: sql`excluded.name`,
					overview: sql`excluded.overview`,
					airDate: sql`excluded.air_date`,
					posterPath: sql`excluded.poster_path`,
					episodeCount: sql`excluded.episode_count`
				}
			});
	}
	// One bound mediaId param + one seasonNumber param per deleted row.
	for (const chunk of chunkBySize(toDelete, D1_MAX_BOUND_PARAMS - 1)) {
		await db
			.delete(seasons)
			.where(
				and(
					eq(seasons.mediaId, id),
					or(...chunk.map((r) => eq(seasons.seasonNumber, r.seasonNumber)))
				)
			);
	}
}

/** Same reconciliation as {@link syncSeasons}, keyed on (seasonNumber, episodeNumber). */
export async function syncEpisodes(
	db: Db,
	id: string,
	oldRows: EpisodeRow[],
	newRows: EpisodeInsert[]
): Promise<void> {
	const key = (r: { seasonNumber: number; episodeNumber: number }) =>
		`${r.seasonNumber}:${r.episodeNumber}`;
	const oldByKey = new Map(oldRows.map((r) => [key(r), r]));
	const newKeys = new Set(newRows.map(key));

	const toUpsert = newRows.filter((r) => {
		const old = oldByKey.get(key(r));
		return !old || contentChanged(old, r, EPISODE_CONTENT_FIELDS);
	});
	const toDelete = oldRows.filter((r) => !newKeys.has(key(r)));

	for (const chunk of chunkRows(toUpsert)) {
		await db
			.insert(episodes)
			.values(chunk)
			.onConflictDoUpdate({
				target: [episodes.mediaId, episodes.seasonNumber, episodes.episodeNumber],
				set: {
					name: sql`excluded.name`,
					overview: sql`excluded.overview`,
					airDate: sql`excluded.air_date`,
					runtime: sql`excluded.runtime`,
					stillPath: sql`excluded.still_path`
				}
			});
	}
	// One bound mediaId param + two (season, episode) params per deleted row.
	for (const chunk of chunkBySize(toDelete, Math.floor((D1_MAX_BOUND_PARAMS - 1) / 2))) {
		await db
			.delete(episodes)
			.where(
				and(
					eq(episodes.mediaId, id),
					or(
						...chunk.map((r) =>
							and(
								eq(episodes.seasonNumber, r.seasonNumber),
								eq(episodes.episodeNumber, r.episodeNumber)
							)
						)
					)
				)
			);
	}
}

/**
 * Ensure a fresh media row (+ its seasons/episodes) exists for `(provider, externalId)` and return
 * it. Cached + TTL-aware: an up-to-date row is returned without touching TMDB. Returns null for an
 * unknown provider / malformed id / first-time TMDB miss (a transient miss on an existing row keeps
 * the stored data). `force` re-pulls even within the TTL; `now` is injectable for tests.
 */
export async function refreshMedia(
	db: Db,
	tmdb: TmdbHydrator,
	provider: MediaProvider,
	externalId: string,
	now: number = Date.now(),
	force = false
): Promise<Media | null> {
	if (provider !== 'tmdb') return null;
	const parsed = parseTmdbExternalId(externalId);
	if (!parsed) return null;

	const id = mediaId(provider, externalId);
	const existingRows = await db.select().from(media).where(eq(media.id, id)).limit(1);
	const existing = existingRows[0] ?? null;
	if (existing && !force && !needsRefresh(existing, now)) return existing;

	const detail = await tmdb.getDetails(parsed.type, parsed.tmdbId).catch((err) => {
		console.error(`refreshMedia: getDetails failed for ${externalId}`, err);
		return null;
	});
	// A transient TMDB miss shouldn't wipe an existing row — keep what we have.
	if (!detail) return existing;

	// Fetch every season's episodes (incl. Specials) for their air dates. Don't swallow a failure —
	// otherwise the show persists with zero episodes; rethrow so the row stays stale and retries.
	const seasonDetails: SeasonDetail[] =
		detail.type === 'show'
			? await Promise.all(
					detail.seasons.map(async (s) => {
						try {
							return await tmdb.getSeason(parsed.tmdbId, s.seasonNumber);
						} catch (err) {
							console.error(
								`refreshMedia: getSeason failed for ${externalId} s${s.seasonNumber}`,
								err
							);
							throw err;
						}
					})
				)
			: [];

	const { scalars, seasonRows, episodeRows } = toRows(
		id,
		provider,
		externalId,
		detail,
		seasonDetails
	);
	// A show with seasons but no episodes is anomalous (all seasons genuinely empty is rare).
	if (detail.type === 'show' && detail.seasons.length > 0 && episodeRows.length === 0) {
		console.warn(
			`refreshMedia: ${externalId} hydrated with ${detail.seasons.length} seasons but 0 episodes`
		);
	}

	if (!existing) {
		await db
			.insert(media)
			.values({ ...scalars, source: 'linked', version: 1, refreshedAt: now })
			.onConflictDoNothing();
		if (detail.type === 'show') {
			await syncSeasons(db, id, [], seasonRows);
			await syncEpisodes(db, id, [], episodeRows);
		}
	} else {
		const oldSeasons: SeasonRow[] =
			detail.type === 'show' ? await db.select().from(seasons).where(eq(seasons.mediaId, id)) : [];
		const oldEpisodes: EpisodeRow[] =
			detail.type === 'show'
				? await db.select().from(episodes).where(eq(episodes.mediaId, id))
				: [];
		const changed =
			existing.title !== scalars.title ||
			existing.status !== scalars.status ||
			existing.inProduction !== scalars.inProduction ||
			existing.lastAirDate !== scalars.lastAirDate ||
			existing.releaseDate !== scalars.releaseDate ||
			seasonSignature(oldSeasons) !== seasonSignature(seasonRows) ||
			episodeSignature(oldEpisodes) !== episodeSignature(episodeRows);
		// Write the children first: if that throws, the media row keeps its old `refreshedAt`, so the
		// next sync retries — rather than being stamped fresh-but-empty and never refreshing again.
		if (detail.type === 'show') {
			await syncSeasons(db, id, oldSeasons, seasonRows);
			await syncEpisodes(db, id, oldEpisodes, episodeRows);
		}
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
