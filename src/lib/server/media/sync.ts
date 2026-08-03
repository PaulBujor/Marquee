/**
 * Core of the media reference channel (`POST /api/media/sync`), extracted from the endpoint so
 * it's testable. Hydrates missing titles and returns rows the client reports as behind — never
 * trusting a client-claimed id, and never touching media the user doesn't actually track
 * (anti-abuse). Unlike the events channel, this is **client-driven**: the client already
 * maintains its own `tracking`/`episode_watches` projections (mirroring the server's), so it
 * knows what it references and what it's missing/behind on without asking — it sends exactly
 * those ids (`refs` for identity to hydrate, `have` for a version-diff), bounded per request.
 * The server validates the request against the user's own `tracking`/`episode_watches` rows
 * (small, indexed by `user_id`) rather than recomputing the whole referenced universe from the
 * append-only `events` log on every call, which is what made this the dominant source of D1
 * read volume before this rework.
 *
 * TTL-based re-hydration of already-stored titles (an in-production show past its airing TTL)
 * is **cron-only** now (`refreshStaleMedia`) — a request-time poll was never a meaningful driver
 * of a 12h TTL, so this path only ever hydrates a title it has *no* stored row for yet.
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
	episodeWatches,
	episodes,
	media,
	seasons,
	tracking,
	type Media
} from '$lib/server/db/schema';
import { mediaId, type MediaRecord } from '$lib/sync/events';
import type { MediaSyncRequest, MediaSyncResponse } from '$lib/sync/media-protocol';
import type { createDb } from '$lib/server/db';
import type { TmdbClient } from '$lib/server/tmdb';
import { refreshMedia } from './hydrate';

type Db = ReturnType<typeof createDb>;
type SeasonRecord = NonNullable<MediaRecord['seasons']>[number];
type EpisodeRecord = NonNullable<MediaRecord['episodes']>[number];

/**
 * D1 caps bound parameters at 100 per query, so `IN (...)` id lists are split into chunks well under
 * it — a user tracking 100+ titles would otherwise overflow the limit ("too many SQL variables").
 * Matches the events projection's dedup chunking.
 */
const ID_CHUNK = 90;

/**
 * Max titles hydrated from TMDB in a single sync request. Each hydrate is a heavy TMDB pull
 * (details + every season) parsed + normalized on the isolate, so an unbounded pass over a large
 * backlog (a cold client, or a bulk import) blows the Worker CPU limit (MRQ-138). Anything beyond
 * the cap is left for the next request — the response's `pending` flag tells the client to loop
 * until it drains.
 */
export const MEDIA_SYNC_REFRESH_MAX = 25;

/** Below any real `media.version` (versions start at 1), so an id absent from `have` is always
 *  treated as "the client has nothing" rather than needing special-cased undefined-handling. */
const NO_VERSION = -1;

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/**
 * The anti-abuse gate: only ids the user's own `tracking`/`episode_watches` projections
 * reference are ever touched, regardless of what the request claims. Both tables are indexed by
 * `user_id` and hold one row per (user, title) — orders of magnitude smaller than the event log
 * they're projected from — so this scoped, chunked lookup replaces what used to be an unbounded
 * `SELECT ... FROM events WHERE user_id = ?` scan of the user's entire history.
 */
async function validateReferencedIds(db: Db, userId: string, ids: string[]): Promise<Set<string>> {
	const valid = new Set<string>();
	for (const c of chunk(ids, ID_CHUNK)) {
		const [trackingRows, watchRows] = await Promise.all([
			db
				.select({ mediaId: tracking.mediaId })
				.from(tracking)
				.where(and(eq(tracking.userId, userId), inArray(tracking.mediaId, c))),
			db
				.select({ mediaId: episodeWatches.mediaId })
				.from(episodeWatches)
				.where(and(eq(episodeWatches.userId, userId), inArray(episodeWatches.mediaId, c)))
		]);
		for (const r of trackingRows) valid.add(r.mediaId);
		for (const r of watchRows) valid.add(r.mediaId);
	}
	return valid;
}

/** Project a media row (+ its child rows) to the wire record (drops the server-only LWW clock). */
function toRecord(
	row: Media,
	seasonRows: SeasonRecord[],
	episodeRows: EpisodeRecord[]
): MediaRecord {
	const isShow = row.type === 'show';
	return {
		id: row.id,
		provider: row.provider,
		externalId: row.externalId,
		source: row.source,
		type: row.type,
		title: row.title,
		year: row.year,
		posterPath: row.posterPath,
		backdropPath: row.backdropPath,
		overview: row.overview,
		genres: row.genres ?? [],
		releaseDate: row.releaseDate ?? null,
		status: row.status ?? null,
		inProduction: row.inProduction ?? null,
		firstAirDate: row.firstAirDate ?? null,
		lastAirDate: row.lastAirDate ?? null,
		version: row.version,
		seasons: isShow ? seasonRows : null,
		episodes: isShow ? episodeRows : null
	};
}

export async function resolveMediaSync(
	db: Db,
	tmdb: Pick<TmdbClient, 'getDetails' | 'getSeason'>,
	userId: string,
	req: MediaSyncRequest,
	now: number = Date.now()
): Promise<MediaSyncResponse> {
	// Identity refs let us hydrate; `have` reports the client's version per id. The request's
	// universe is whatever ids appear in either — no independent recomputation from the log.
	const refById = new Map(req.refs.map((ref) => [mediaId(ref.provider, ref.externalId), ref]));
	const haveVersion = new Map(req.have.map((h) => [h.id, h.version]));
	const requestedIds = [...new Set([...refById.keys(), ...haveVersion.keys()])];
	if (requestedIds.length === 0) return { media: [] };

	const validIds = await validateReferencedIds(db, userId, requestedIds);
	if (validIds.size === 0) return { media: [] };

	// Chunk every `IN (...)` id list under D1's bound-parameter limit (a large tracked library
	// otherwise overflows it — the media sync 500 this fixes).
	const loadMedia = async (ids: string[]): Promise<Media[]> =>
		(
			await Promise.all(
				chunk(ids, ID_CHUNK).map((c) => db.select().from(media).where(inArray(media.id, c)))
			)
		).flat();

	const existingById = new Map((await loadMedia([...validIds])).map((r) => [r.id, r]));

	// Only a title with *no* stored row needs TMDB work here — an existing-but-stale row is the
	// nightly cron's job (`refreshStaleMedia`), not a request-time concern.
	const missing: typeof req.refs = [];
	for (const id of validIds) {
		const ref = refById.get(id);
		if (ref && !existingById.has(id)) missing.push(ref);
	}

	const toRefresh = missing.slice(0, MEDIA_SYNC_REFRESH_MAX);
	const pending = missing.length > MEDIA_SYNC_REFRESH_MAX;
	if (pending) {
		console.warn(
			`media sync: ${missing.length} titles missing, capping at ${MEDIA_SYNC_REFRESH_MAX} (user ${userId})`
		);
	}

	// Isolate per-title failures so one bad title doesn't fail the whole sync — the failed row keeps
	// its old data and retries next cycle.
	for (const ref of toRefresh) {
		try {
			await refreshMedia(db, tmdb, ref.provider, ref.externalId, now);
		} catch (err) {
			console.error(`media sync: refresh failed for ${ref.provider}:${ref.externalId}`, err);
		}
	}

	// Re-read only the ids we just hydrated (not the whole request) and fold them in — everything
	// else is unchanged since `existingById` was read above.
	if (toRefresh.length > 0) {
		const refreshedIds = toRefresh.map((ref) => mediaId(ref.provider, ref.externalId));
		for (const row of await loadMedia(refreshedIds)) existingById.set(row.id, row);
	}

	const staleForClient = [...validIds]
		.map((id) => existingById.get(id))
		.filter((r): r is Media => r !== undefined)
		.filter((r) => (haveVersion.get(r.id) ?? NO_VERSION) < r.version);
	if (staleForClient.length === 0) return { media: [], pending };

	const staleShowIds = staleForClient.filter((r) => r.type === 'show').map((r) => r.id);
	const seasonRows = (
		await Promise.all(
			chunk(staleShowIds, ID_CHUNK).map((ids) =>
				db.select().from(seasons).where(inArray(seasons.mediaId, ids))
			)
		)
	).flat();
	const episodeRows = (
		await Promise.all(
			chunk(staleShowIds, ID_CHUNK).map((ids) =>
				db.select().from(episodes).where(inArray(episodes.mediaId, ids))
			)
		)
	).flat();

	const seasonsByMedia = new Map<string, SeasonRecord[]>();
	for (const s of seasonRows) {
		const list = seasonsByMedia.get(s.mediaId) ?? [];
		list.push({
			seasonNumber: s.seasonNumber,
			name: s.name,
			overview: s.overview,
			airDate: s.airDate,
			posterPath: s.posterPath,
			episodeCount: s.episodeCount
		});
		seasonsByMedia.set(s.mediaId, list);
	}
	const episodesByMedia = new Map<string, EpisodeRecord[]>();
	for (const e of episodeRows) {
		const list = episodesByMedia.get(e.mediaId) ?? [];
		list.push({
			season: e.seasonNumber,
			episode: e.episodeNumber,
			name: e.name,
			overview: e.overview,
			airDate: e.airDate,
			runtime: e.runtime,
			stillPath: e.stillPath
		});
		episodesByMedia.set(e.mediaId, list);
	}

	return {
		media: staleForClient.map((r) =>
			toRecord(r, seasonsByMedia.get(r.id) ?? [], episodesByMedia.get(r.id) ?? [])
		),
		pending
	};
}
