/**
 * Core of the media reference channel (`POST /api/media/sync`), extracted from the endpoint so
 * it's testable. Hydrates/refreshes + returns the media a user's events reference — never trusting
 * a client-claimed id, and never touching media the user doesn't actually track (anti-abuse). The
 * client reports what it `have`s (id + version); the server returns rows it's missing or behind on
 * (server version > client version).
 */
import { eq, inArray } from 'drizzle-orm';
import { episodes, events, media, seasons, type Media } from '$lib/server/db/schema';
import { mediaId, type MediaRecord } from '$lib/sync/events';
import type { MediaSyncRequest, MediaSyncResponse } from '$lib/sync/media-protocol';
import type { createDb } from '$lib/server/db';
import type { TmdbClient } from '$lib/server/tmdb';
import { needsRefresh, refreshMedia } from './hydrate';

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
 * Max titles hydrated/refreshed from TMDB in a single sync request. Each refresh is a heavy TMDB
 * pull (details + every season) parsed + normalized on the isolate, so an unbounded pass over a
 * whole library blows the Worker CPU limit. Anything beyond the cap is left for the next
 * sync — the response's `pending` flag tells the client to loop until it drains — plus the nightly
 * cron, which sweeps airing shows regardless.
 */
export const MEDIA_SYNC_REFRESH_MAX = 25;

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
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
	// Identity refs let us hydrate; `have` reports the client's version per id.
	const refById = new Map(req.refs.map((ref) => [mediaId(ref.provider, ref.externalId), ref]));
	const haveVersion = new Map(req.have.map((h) => [h.id, h.version]));

	// The universe the client cares about = every media id the user's own events reference.
	// Deriving it from the log (not from the request) is the anti-abuse gate: a ref for a title
	// the user doesn't track is never acted on.
	const referenced = await db
		.select({ id: events.entityId })
		.from(events)
		.where(eq(events.userId, userId));
	const referencedIds = [...new Set(referenced.map((r) => r.id))];
	if (referencedIds.length === 0) return { media: [] };

	// Chunk every `IN (...)` id list under D1's bound-parameter limit (a large tracked library
	// otherwise overflows it — the media sync 500 this fixes).
	const loadMedia = async (ids: string[]): Promise<Media[]> =>
		(
			await Promise.all(
				chunk(ids, ID_CHUNK).map((c) => db.select().from(media).where(inArray(media.id, c)))
			)
		).flat();

	// Decide what needs a TMDB pull *before* touching TMDB: a fresh stored row costs nothing (skip
	// it) — only missing rows (new adds) and stale ones (past TTL) do. This keeps a steady-state sync,
	// where nothing is stale, from re-fetching the whole library on every cycle.
	const existingById = new Map((await loadMedia(referencedIds)).map((r) => [r.id, r]));
	const missing: typeof req.refs = [];
	const stale: typeof req.refs = [];
	for (const id of referencedIds) {
		const ref = refById.get(id);
		if (!ref) continue; // no identity → can't hydrate; a stored row is still returned as-is below
		const existing = existingById.get(id);
		if (!existing) missing.push(ref);
		else if (needsRefresh(existing, now)) stale.push(ref);
	}

	// Cap the per-request TMDB work: an unbounded serial refresh over the whole library
	// blows the Worker CPU limit. Missing rows first — they have no data to return yet, so hydrating
	// them unblocks the client fastest; stale-but-stored rows already return usable data and the cron
	// keeps them current. Overflow is signalled via `pending` so the client loops to drain it.
	const candidates = [...missing, ...stale];
	const toRefresh = candidates.slice(0, MEDIA_SYNC_REFRESH_MAX);
	const pending = candidates.length > MEDIA_SYNC_REFRESH_MAX;
	if (pending) {
		console.warn(
			`media sync: ${candidates.length} titles need refresh, capping at ${MEDIA_SYNC_REFRESH_MAX} (user ${userId})`
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

	// Re-read after refresh so the response carries freshly-hydrated rows and bumped versions.
	const rows = await loadMedia(referencedIds);
	const staleForClient = rows.filter((r) => {
		const clientVersion = haveVersion.get(r.id);
		return clientVersion === undefined || r.version > clientVersion;
	});
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
