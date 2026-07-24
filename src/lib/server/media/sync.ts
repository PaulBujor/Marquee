/**
 * Core of the media reference channel (`POST /api/media/sync`), extracted from the endpoint so
 * it's testable. Hydrates/refreshes + returns the media a user's events reference — never trusting
 * a client-claimed id, and never touching media the user doesn't actually track (anti-abuse). The
 * client reports what it `have`s (id + version); the server returns rows it's **missing or behind
 * on** (server version > client version) — the version-diff staleness signal (MRQ-122).
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

/** Assemble the wire record for a media row + its child rows (drops the server-only LWW clock). */
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
	for (const id of referencedIds) {
		const ref = refById.get(id);
		if (ref) await refreshMedia(db, tmdb, ref.provider, ref.externalId);
	}

	// Return rows the client is missing (no `have` entry) or behind on (server version higher).
	const rows = await db.select().from(media).where(inArray(media.id, referencedIds));
	const changed = rows.filter((r) => {
		const v = haveVersion.get(r.id);
		return v === undefined || r.version > v;
	});
	if (changed.length === 0) return { media: [] };

	const changedShowIds = changed.filter((r) => r.type === 'show').map((r) => r.id);
	const seasonRows = changedShowIds.length
		? await db.select().from(seasons).where(inArray(seasons.mediaId, changedShowIds))
		: [];
	const episodeRows = changedShowIds.length
		? await db.select().from(episodes).where(inArray(episodes.mediaId, changedShowIds))
		: [];

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
		media: changed.map((r) =>
			toRecord(r, seasonsByMedia.get(r.id) ?? [], episodesByMedia.get(r.id) ?? [])
		)
	};
}
