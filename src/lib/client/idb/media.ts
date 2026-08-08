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

/**
 * Upsert many media records in one transaction. `putMedia` opens its own three-store transaction
 * per record, which an import of a whole library turns into thousands of them.
 */
export async function putMediaBatch(records: MediaRecord[]): Promise<void> {
	if (records.length === 0) return;
	const db = await openDb();
	const tx = db.transaction(['media', 'seasons', 'episodes'], 'readwrite');
	const mediaStore = tx.objectStore('media');
	const seasonStore = tx.objectStore('seasons');
	const episodeStore = tx.objectStore('episodes');
	const now = Date.now();

	for (const record of records) {
		const { seasons, episodes, ...scalars } = record;
		await mediaStore.put({ ...scalars, updatedAt: now });
		// Same rule as putMedia: a null child array is a scalar-only snapshot and leaves any
		// already-synced child rows alone; a non-null one replaces them.
		if (seasons) {
			for (const key of await seasonStore.index('by_media').getAllKeys(record.id)) {
				await seasonStore.delete(key);
			}
			for (const s of seasons) {
				await seasonStore.put({
					...s,
					id: seasonKey(record.id, s.seasonNumber),
					mediaId: record.id
				});
			}
		}
		if (episodes) {
			for (const key of await episodeStore.index('by_media').getAllKeys(record.id)) {
				await episodeStore.delete(key);
			}
			for (const e of episodes) {
				await episodeStore.put({
					...e,
					id: episodeKey(record.id, e.season, e.episode),
					mediaId: record.id
				});
			}
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
 * Media ids on a list — a non-removed `tracking` row, or a `watched: true` episode. Both what the
 * media channel asks the server about and the keep-set eviction runs against, so a title stops
 * being fetched and starts being dropped the moment it leaves every list. Tombstones (a removed
 * tracking row, a `watched: false` episode) don't count.
 */
export async function getReferencedMediaIds(): Promise<string[]> {
	const db = await openDb();
	const ids = new Set<string>();
	for (const row of await db.getAll('tracking')) if (!row.removed) ids.add(row.mediaId);
	for (const row of await db.getAll('episodeWatches')) if (row.watched) ids.add(row.mediaId);
	return [...ids];
}

/**
 * Drop `media` rows and their `seasons`/`episodes` children for ids outside `keepIds`. No
 * storage-pressure gate like `pruneMediaImages` has — reference data is small and re-fetched from
 * the channel on re-add, so leaving every list is reason enough. Returns how many rows were deleted.
 */
export async function pruneStaleMedia(keepIds: Set<string>): Promise<number> {
	const db = await openDb();
	const tx = db.transaction(['media', 'seasons', 'episodes'], 'readwrite');
	const mediaStore = tx.objectStore('media');
	const seasonStore = tx.objectStore('seasons');
	const episodeStore = tx.objectStore('episodes');
	const seasonIndex = seasonStore.index('by_media');
	const episodeIndex = episodeStore.index('by_media');
	let deleted = 0;

	for (let cursor = await mediaStore.openCursor(); cursor; cursor = await cursor.continue()) {
		if (keepIds.has(cursor.value.id)) continue;
		const id = cursor.value.id;
		await cursor.delete();
		deleted++;
		for (const key of await seasonIndex.getAllKeys(id)) await seasonStore.delete(key);
		for (const key of await episodeIndex.getAllKeys(id)) await episodeStore.delete(key);
	}

	await tx.done;
	return deleted;
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
