/** Validates against the user's own tracking rows (anti-abuse); TTL refresh is cron-only. */
import { and, eq, inArray } from 'drizzle-orm';
import {
	episodeWatches,
	episodes,
	media,
	seasons,
	tracking,
	type Media
} from '#lib/server/db/schema.js';
import { mediaId, trackingKey, type MediaCredit, type MediaRecord } from '#lib/sync/events.js';
import type { MediaSyncRequest, MediaSyncResponse } from '#lib/sync/media-protocol.js';
import { chunkIds } from '#lib/server/db/chunk.js';
import type { createDb } from '#lib/server/db/index.js';
import type { TmdbClient } from '#lib/server/tmdb/index.js';
import { loadCreditsForMedia } from './credits';
import { storeCustomMedia } from './custom';
import { refreshMedia } from './hydrate';

type Db = ReturnType<typeof createDb>;
type SeasonRecord = NonNullable<MediaRecord['seasons']>[number];
type EpisodeRecord = NonNullable<MediaRecord['episodes']>[number];

/** An unbounded pass blows the Worker CPU limit on a cold client or bulk import; `pending` tells the client to loop. */
export const MEDIA_SYNC_REFRESH_MAX = 25;

/** Below any real `media.version` (versions start at 1), so an id absent from `have` reads as "the client has nothing". */
const NO_VERSION = -1;

/** Only ids the user's own tracking/episode_watches reference are touched. `tracking` is looked up by PK because its only index is `(user_id, status)`, so an `eq` + `inArray` filter would scan the whole table. */
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

/** Project a media row to the wire record, dropping the server-only LWW clock. */
function toRecord(
	row: Media,
	seasonRows: SeasonRecord[],
	episodeRows: EpisodeRecord[],
	creditRows: MediaCredit[]
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
		episodes: isShow ? episodeRows : null,
		// Always an array, never null: null would tell the client "unknown, keep what you have", stranding a cast that was legitimately emptied upstream.
		credits: creditRows
	};
}

async function withChildren(db: Db, rows: Media[]): Promise<MediaRecord[]> {
	if (rows.length === 0) return [];
	const showIds = rows.filter((r) => r.type === 'show').map((r) => r.id);
	const creditsByMedia = await loadCreditsForMedia(
		db,
		rows.map((r) => r.id)
	);
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
		toRecord(
			r,
			seasonsByMedia.get(r.id) ?? [],
			episodesByMedia.get(r.id) ?? [],
			creditsByMedia.get(r.id) ?? []
		)
	);
}

export async function resolveMediaSync(
	db: Db,
	tmdb: Pick<TmdbClient, 'getDetails' | 'getSeason'>,
	userId: string,
	req: MediaSyncRequest,
	now: number = Date.now()
): Promise<MediaSyncResponse> {
	// The request's universe is whatever ids appear in refs/have/custom — no recomputation from the log.
	const refById = new Map(req.refs.map((ref) => [mediaId(ref.provider, ref.externalId), ref]));
	const haveVersion = new Map(req.have.map((h) => [h.id, h.version]));
	const pushedCustom = req.custom ?? [];
	const requestedIds = [
		...new Set([...refById.keys(), ...haveVersion.keys(), ...pushedCustom.map((c) => c.id)])
	];
	if (requestedIds.length === 0) return { media: [] };

	const validIds = await validateReferencedIds(db, userId, requestedIds);
	// Writes come before reads: a record stored now should come back in this same response.
	const storedCustom =
		pushedCustom.length > 0 ? await storeCustomMedia(db, userId, pushedCustom, validIds) : [];

	// Chunked under D1's bound-parameter limit — a large tracked library otherwise overflows it.
	const loadMedia = async (ids: string[]): Promise<Media[]> =>
		(
			await Promise.all(
				chunkIds(ids).map((c) => db.select().from(media).where(inArray(media.id, c)))
			)
		).flat();

	const existingById = new Map((await loadMedia([...validIds])).map((r) => [r.id, r]));

	// Only a title with *no* stored row is hydrated here; an existing-but-stale row is the nightly cron's job.
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

	if (toRefresh.length > 0) {
		const refreshedIds = toRefresh.map((ref) => mediaId(ref.provider, ref.externalId));
		for (const row of await loadMedia(refreshedIds)) existingById.set(row.id, row);
	}

	const staleForClient = [...validIds]
		.map((id) => existingById.get(id))
		.filter((r): r is Media => r !== undefined)
		// The tracking gate proves the *asker* references the id, not that they may read it — an id can be referenced by minting an event, so ownership is what protects the row.
		.filter((r) => r.ownerUserId === null || r.ownerUserId === userId)
		.filter((r) => (haveVersion.get(r.id) ?? NO_VERSION) < r.version);

	return { media: await withChildren(db, staleForClient), pending, storedCustom };
}
