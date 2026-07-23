/**
 * Core of the media reference channel (`POST /api/media/sync`), extracted from the endpoint so
 * it's testable. Hydrates + returns the media a user's events reference — never trusting a
 * client-claimed id, and never hydrating media the user doesn't actually track (anti-abuse).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { events, media, type Media } from '$lib/server/db/schema';
import { mediaId, type MediaRecord } from '$lib/sync/events';
import type { MediaSyncRequest, MediaSyncResponse } from '$lib/sync/media-protocol';
import type { createDb } from '$lib/server/db';
import type { TmdbClient } from '$lib/server/tmdb';
import { hydrateMedia } from './hydrate';

type Db = ReturnType<typeof createDb>;

/** Project a server media row to the wire/record shape (drops the server-only LWW clock). */
function toRecord(row: Media): MediaRecord {
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
		seasons: row.seasons
	};
}

export async function resolveMediaSync(
	db: Db,
	tmdb: Pick<TmdbClient, 'getDetails'>,
	userId: string,
	req: MediaSyncRequest
): Promise<MediaSyncResponse> {
	// Derive our id for each identity ref (ignore any client-claimed id) and union with `need`.
	const refById = new Map(req.refs.map((ref) => [mediaId(ref.provider, ref.externalId), ref]));
	const candidateIds = [...new Set([...refById.keys(), ...req.need])];
	if (candidateIds.length === 0) return { media: [] };

	// Anti-abuse: only touch media the user's own (synced) events reference.
	const referenced = await db
		.select({ id: events.entityId })
		.from(events)
		.where(and(eq(events.userId, userId), inArray(events.entityId, candidateIds)));
	const allowed = [...new Set(referenced.map((r) => r.id))];
	if (allowed.length === 0) return { media: [] };

	// Hydrate any allowed id we have identity for (cached — TMDB hit only when missing).
	for (const id of allowed) {
		const ref = refById.get(id);
		if (ref) await hydrateMedia(db, tmdb, ref.provider, ref.externalId);
	}

	const rows = await db.select().from(media).where(inArray(media.id, allowed));
	return { media: rows.map(toRecord) };
}
