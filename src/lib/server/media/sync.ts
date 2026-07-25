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
	req: MediaSyncRequest
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

	// Refresh/hydrate any referenced id we have identity for (TTL-aware; TMDB only when stale).
	// Isolate per-title failures so one bad title doesn't fail the whole sync — the failed row keeps
	// its old data and retries next cycle.
	for (const id of referencedIds) {
		const ref = refById.get(id);
		if (!ref) continue;
		try {
			await refreshMedia(db, tmdb, ref.provider, ref.externalId);
		} catch (err) {
			console.error(`media sync: refresh failed for ${ref.provider}:${ref.externalId}`, err);
		}
	}

	// Chunk every `IN (...)` id list under D1's bound-parameter limit (a large tracked library
	// otherwise overflows it — the media sync 500 this fixes).
	const rows = (
		await Promise.all(
			chunk(referencedIds, ID_CHUNK).map((ids) =>
				db.select().from(media).where(inArray(media.id, ids))
			)
		)
	).flat();
	const staleForClient = rows.filter((r) => {
		const clientVersion = haveVersion.get(r.id);
		return clientVersion === undefined || r.version > clientVersion;
	});
	if (staleForClient.length === 0) return { media: [] };

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
		)
	};
}
