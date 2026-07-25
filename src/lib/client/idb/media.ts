/**
 * `media` store accessors. A {@link MediaRecord} is stored split across three stores mirroring the
 * server: scalar fields in `media`, and (for shows) the nested arrays in `seasons`/`episodes`.
 */
import { openDb, type ClientEpisode, type ClientMedia } from './db';
import type { MediaProvider, MediaRecord } from '$lib/sync/events';

function seasonKey(mediaId: string, seasonNumber: number): string {
	return `${mediaId}::s${seasonNumber}`;
}

function episodeKey(mediaId: string, season: number, episode: number): string {
	return `${mediaId}::s${season}e${episode}`;
}

/**
 * Upsert a media record. A null `seasons`/`episodes` (a scalar-only track-time snapshot) leaves any
 * existing child rows untouched; a non-null one (a full channel pull) replaces them — so a snapshot
 * never wipes synced episode data.
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

export async function getMedia(id: string): Promise<ClientMedia | undefined> {
	return (await openDb()).get('media', id);
}

export async function getAllMedia(): Promise<ClientMedia[]> {
	return (await openDb()).getAll('media');
}

/** A title's cached episodes — the source for watchability + progress. */
export async function getEpisodes(mediaId: string): Promise<ClientEpisode[]> {
	return (await openDb()).getAllFromIndex('episodes', 'by_media', mediaId);
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

/** Each local media id + the version held — the version-diff report the media channel sends. */
export async function getMediaVersions(): Promise<{ id: string; version: number }[]> {
	const all = await getAllMedia();
	return all.map((m) => ({ id: m.id, version: m.version ?? 0 }));
}
