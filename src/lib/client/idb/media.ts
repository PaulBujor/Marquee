/**
 * `media` store accessors. A {@link MediaRecord} is stored split across three stores mirroring the
 * server: scalar fields in `media`, and (for shows) the nested arrays in `seasons`/`episodes`.
 */
import { openDb, type ClientEpisode, type ClientMedia, type ClientSeason } from './db';
import type { MediaProvider, MediaRecord } from '$lib/sync/events';
import { parseTmdbExternalId, type SearchLikeMedia } from '$lib/tracking/media-record';

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

/**
 * Offline search over the locally-cached catalog — the user's own titles only. Scoped to
 * provider-backed `linked` rows with a known external id (so each result can open its detail page),
 * a case-insensitive title substring, mapped to the same shape as a TMDB search result.
 */
export async function searchLocalMedia(query: string, limit = 20): Promise<SearchLikeMedia[]> {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const matches: SearchLikeMedia[] = [];
	for (const m of await getAllMedia()) {
		if (m.source !== 'linked' || m.externalId === null) continue;
		if (!m.title.toLowerCase().includes(q)) continue;
		const ref = parseTmdbExternalId(m.externalId);
		if (!ref) continue;
		matches.push({
			tmdbId: ref.tmdbId,
			type: m.type,
			title: m.title,
			year: m.year,
			posterPath: m.posterPath,
			overview: m.overview
		});
	}
	return matches.sort((a, b) => a.title.localeCompare(b.title)).slice(0, limit);
}

/** A title's cached seasons — the source for the season selector when rendering offline. */
export async function getSeasons(mediaId: string): Promise<ClientSeason[]> {
	return (await openDb()).getAllFromIndex('seasons', 'by_media', mediaId);
}

/** A title's cached episodes — the source for watchability + progress. */
export async function getEpisodes(mediaId: string): Promise<ClientEpisode[]> {
	return (await openDb()).getAllFromIndex('episodes', 'by_media', mediaId);
}

/**
 * Every media id the local `tracking`/`episodeWatches` projections reference — the client-side
 * mirror of what the server would derive from the same projections. Unconditional (a removed
 * tracking row still counts, matching the server's scope): `tracking`'s keyPath *is* `mediaId`,
 * so this is two cheap local index reads, no filtering needed beyond dedup.
 */
export async function getReferencedMediaIds(): Promise<string[]> {
	const db = await openDb();
	const ids = new Set<string>(await db.getAllKeys('tracking'));
	for (const row of await db.getAll('episodeWatches')) ids.add(row.mediaId);
	return [...ids];
}

/**
 * Referenced ids the client has no synced copy of yet — no local row at all, or the `version: 0`
 * placeholder a quick-add snapshot seeds (see `mediaRecordFromSearch`). These are what the media
 * channel needs to ask the server about; everything else stays local until the next full check.
 */
export async function getUnsyncedMediaIds(referencedIds: string[]): Promise<string[]> {
	const rows = await Promise.all(referencedIds.map((id) => getMedia(id)));
	return referencedIds.filter((_, i) => !rows[i] || rows[i]?.version === 0);
}

/** Identity of locally-known provider-backed media among `ids`, to push to the channel for server
 *  hydration. */
export async function getLinkedMediaRefs(
	ids: string[]
): Promise<{ provider: MediaProvider; externalId: string }[]> {
	const rows = await Promise.all(ids.map((id) => getMedia(id)));
	return rows
		.filter((m): m is ClientMedia => !!m && m.source === 'linked' && m.externalId !== null)
		.map((m) => ({ provider: m.provider, externalId: m.externalId as string }));
}

/** `id` + the version held for each of `ids` (0 when there's no local row) — the version-diff
 *  report the media channel sends. */
export async function getMediaVersions(ids: string[]): Promise<{ id: string; version: number }[]> {
	return Promise.all(ids.map(async (id) => ({ id, version: (await getMedia(id))?.version ?? 0 })));
}
