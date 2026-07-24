/**
 * `media` store accessors — the client's cache of media reference data (title/poster + a show's
 * seasons/episodes). A {@link MediaRecord} is stored split across three stores mirroring the server:
 * scalar fields in `media`, and (for shows) the nested arrays fanned out into `seasons`/`episodes`.
 */
import { openDb, type ClientEpisode, type ClientMedia, type ClientSeason } from './db';
import type { MediaProvider, MediaRecord } from '$lib/sync/events';

/** Deterministic client-store key for a season row. */
function seasonKey(mediaId: string, seasonNumber: number): string {
	return `${mediaId}::s${seasonNumber}`;
}

/** Deterministic client-store key for an episode row. */
function episodeKey(mediaId: string, season: number, episode: number): string {
	return `${mediaId}::s${season}e${episode}`;
}

/**
 * Upsert a media record (from a track-time capture or a channel pull). Writes the scalar fields to
 * `media`; when the record carries `seasons`/`episodes` (a full channel pull, not a scalar-only
 * track-time snapshot), it **replaces** that title's child rows. A null `seasons`/`episodes` leaves
 * any existing child rows untouched, so a scalar snapshot never wipes synced episode data.
 */
export async function putMedia(record: MediaRecord): Promise<void> {
	const { seasons, episodes, ...scalars } = record;
	const db = await openDb();
	const tx = db.transaction(['media', 'seasons', 'episodes'], 'readwrite');
	await tx.objectStore('media').put({ ...scalars, updatedAt: Date.now() });

	if (seasons) {
		const store = tx.objectStore('seasons');
		const index = store.index('by_media');
		for (const key of await index.getAllKeys(record.id)) await store.delete(key);
		for (const s of seasons) {
			await store.put({ ...s, id: seasonKey(record.id, s.seasonNumber), mediaId: record.id });
		}
	}
	if (episodes) {
		const store = tx.objectStore('episodes');
		const index = store.index('by_media');
		for (const key of await index.getAllKeys(record.id)) await store.delete(key);
		for (const e of episodes) {
			await store.put({ ...e, id: episodeKey(record.id, e.season, e.episode), mediaId: record.id });
		}
	}
	await tx.done;
}

/** A single cached media row (scalars), or undefined. */
export async function getMedia(id: string): Promise<ClientMedia | undefined> {
	return (await openDb()).get('media', id);
}

/** All cached media rows (scalars). */
export async function getAllMedia(): Promise<ClientMedia[]> {
	return (await openDb()).getAll('media');
}

/** A title's cached seasons. */
export async function getSeasons(mediaId: string): Promise<ClientSeason[]> {
	return (await openDb()).getAllFromIndex('seasons', 'by_media', mediaId);
}

/** A title's cached episodes (with air dates) — the source for watchability + progress. */
export async function getEpisodes(mediaId: string): Promise<ClientEpisode[]> {
	return (await openDb()).getAllFromIndex('episodes', 'by_media', mediaId);
}

/**
 * Cached episodes airing on/after `fromDate` (`YYYY-MM-DD`), across all titles — the upcoming
 * calendar's range scan over the `by_airDate` index (episodes with a null air date are excluded).
 */
export async function getEpisodesAiringFrom(fromDate: string): Promise<ClientEpisode[]> {
	return (await openDb()).getAllFromIndex(
		'episodes',
		'by_airDate',
		IDBKeyRange.lowerBound(fromDate)
	);
}

/** Identity of locally-known provider-backed media, to push to the channel for server hydration. */
export async function getLinkedMediaRefs(): Promise<
	{ provider: MediaProvider; externalId: string }[]
> {
	const all = await getAllMedia();
	return all
		.filter((m) => m.source === 'linked' && m.externalId !== null)
		.map((m) => ({ provider: m.provider, externalId: m.externalId as string }));
}

/** What the client has, per media id + version — the version-diff staleness report (MRQ-122). */
export async function getMediaVersions(): Promise<{ id: string; version: number }[]> {
	const all = await getAllMedia();
	return all.map((m) => ({ id: m.id, version: m.version ?? 0 }));
}
