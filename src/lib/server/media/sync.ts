/**
 * Core of the media reference channel (`POST /api/media/sync`). Hydrates missing titles and returns
 * rows the client is behind on. Client-driven: the client sends `refs` (identity to hydrate) and
 * `have` (version-diff), bounded per request. TTL re-hydration is cron-only now — this path only
 * hydrates a title with no stored row yet. Also carries user-authored custom media (see `./custom`).
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
import { mediaId, trackingKey, type MediaRecord } from '$lib/sync/events';
import type { MediaSyncRequest, MediaSyncResponse } from '$lib/sync/media-protocol';
import { chunkIds } from '$lib/server/db/chunk';
import type { createDb } from '$lib/server/db';
import type { TmdbClient } from '$lib/server/tmdb';
import { storeCustomMedia } from './custom';
import { refreshMedia } from './hydrate';

type Db = ReturnType<typeof createDb>;
type SeasonRecord = NonNullable<MediaRecord['seasons']>[number];
type EpisodeRecord = NonNullable<MediaRecord['episodes']>[number];

export const MEDIA_SYNC_REFRESH_MAX = 25;

/** Sentinel below any real `media.version` — absent from `have` means the client has nothing. */
const NO_VERSION = -1;

/** Anti-abuse gate: only ids the user's own `tracking`/`episode_watches` reference are touched. */
async function validateReferencedIds(db: Db, userId: string, ids: string[]): Promise<Set<string>> {
	const valid = new Set<string>();
	for (const c of chunkIds(ids)) {
		const [trackingRows, watchRows] = await Promise.all([
			db
				.select({ mediaId: tracking.mediaId })
				.from(tracking)
				.where(
					inArray(
						tracking.id,
						c.map((id) => trackingKey(userId, id))
					)
				),
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

/** Attach each show's seasons/episodes and project the whole set to wire records. */
async function withChildren(db: Db, rows: Media[]): Promise<MediaRecord[]> {
	if (rows.length === 0) return [];
	const showIds = rows.filter((r) => r.type === 'show').map((r) => r.id);
	const [seasonRows, episodeRows] = await Promise.all([
		Promise.all(
			chunkIds(showIds).map((ids) => db.select().from(seasons).where(inArray(seasons.mediaId, ids)))
		).then((r) => r.flat()),
		Promise.all(
			chunkIds(showIds).map((ids) =>
				db.select().from(episodes).where(inArray(episodes.mediaId, ids))
			)
		).then((r) => r.flat())
	]);

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

	return rows.map((r) =>
		toRecord(r, seasonsByMedia.get(r.id) ?? [], episodesByMedia.get(r.id) ?? [])
	);
}

export async function resolveMediaSync(
	db: Db,
	tmdb: Pick<TmdbClient, 'getDetails' | 'getSeason'>,
	userId: string,
	req: MediaSyncRequest,
	now: number = Date.now()
): Promise<MediaSyncResponse> {
	const refById = new Map(req.refs.map((ref) => [mediaId(ref.provider, ref.externalId), ref]));
	const haveVersion = new Map(req.have.map((h) => [h.id, h.version]));
	const pushedCustom = req.custom ?? [];
	const requestedIds = [
		...new Set([...refById.keys(), ...haveVersion.keys(), ...pushedCustom.map((c) => c.id)])
	];
	if (requestedIds.length === 0) return { media: [] };

	const validIds = await validateReferencedIds(db, userId, requestedIds);
	const storedCustom =
		pushedCustom.length > 0 ? await storeCustomMedia(db, userId, pushedCustom, validIds) : [];

	// Chunk every IN list under D1's bound-parameter limit.
	const loadMedia = async (ids: string[]): Promise<Media[]> =>
		(
			await Promise.all(
				chunkIds(ids).map((c) => db.select().from(media).where(inArray(media.id, c)))
			)
		).flat();

	const existingById = new Map((await loadMedia([...validIds])).map((r) => [r.id, r]));

	// Only titles with no stored row need TMDB work — stale rows are the cron's job.
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

	// Isolate per-title failures so one bad title doesn't fail the whole sync.
	for (const ref of toRefresh) {
		try {
			await refreshMedia(db, tmdb, ref.provider, ref.externalId, now);
		} catch (err) {
			console.error(`media sync: refresh failed for ${ref.provider}:${ref.externalId}`, err);
		}
	}

	// Re-read only the ids we just hydrated and fold them in.
	if (toRefresh.length > 0) {
		const refreshedIds = toRefresh.map((ref) => mediaId(ref.provider, ref.externalId));
		for (const row of await loadMedia(refreshedIds)) existingById.set(row.id, row);
	}

	const staleForClient = [...validIds]
		.map((id) => existingById.get(id))
		.filter((r): r is Media => r !== undefined)
		// A private row belongs to exactly one account; ownership is checked separately from the
		// tracking gate (which proves the user references the id, not that they own it).
		.filter((r) => r.ownerUserId === null || r.ownerUserId === userId)
		.filter((r) => (haveVersion.get(r.id) ?? NO_VERSION) < r.version);

	return { media: await withChildren(db, staleForClient), pending, storedCustom };
}
