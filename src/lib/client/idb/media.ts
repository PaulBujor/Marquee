import {
	openDb,
	type ClientCredit,
	type ClientEpisode,
	type ClientMedia,
	type ClientSeason
} from './db';
import {
	isHydratableProvider,
	type HydratableProvider,
	type MediaRecord
} from '#lib/sync/events.js';
import type { CustomMediaPush } from '#lib/sync/media-protocol.js';
import { parseTmdbExternalId, type SearchLikeMedia } from '#lib/tracking/media-record.js';

function seasonKey(mediaId: string, seasonNumber: number): string {
	return `${mediaId}::s${seasonNumber}`;
}

function episodeKey(mediaId: string, season: number, episode: number): string {
	return `${mediaId}::s${season}e${episode}`;
}

function creditKey(mediaId: string, role: string, personId: string): string {
	return `${mediaId}::${role}::${personId}`;
}

const MEDIA_STORES = ['media', 'seasons', 'episodes', 'credits'] as const;

/**
 * A locally-authored row with an unpushed edit is left alone: the incoming copy is the server's, and
 * the server hasn't seen that edit, so applying it would silently discard what the user typed.
 */
export async function putMedia(record: MediaRecord): Promise<void> {
	return writeMedia(record, { respectPending: true });
}

/** `respectPending: false` is the author's own path — an edit must overwrite an earlier unpushed one. */
async function writeMedia(
	record: MediaRecord,
	opts: { respectPending: boolean; pending?: { editedAt: number } }
): Promise<void> {
	const { seasons, episodes, credits, ...scalars } = record;
	const db = await openDb();
	const tx = db.transaction(MEDIA_STORES, 'readwrite');
	const mediaStore = tx.objectStore('media');
	const existing = await mediaStore.get(record.id);
	if (opts.respectPending && existing?.source === 'custom' && existing.pendingPush === 1) {
		await tx.done;
		return;
	}
	await mediaStore.put({
		// Carry the backup fields forward: an unrelated write must not drop the edit clock a later
		// push compares against.
		...(existing ? { pendingPush: existing.pendingPush, editedAt: existing.editedAt } : {}),
		...scalars,
		updatedAt: Date.now(),
		...(opts.pending ? { pendingPush: 1 as const, editedAt: opts.pending.editedAt } : {})
	});

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
	// null is "unknown, leave what's stored" (a quick-add snapshot); `[]` clears them.
	if (credits) {
		const store = tx.objectStore('credits');
		const index = store.index('by_media');
		for (const key of await index.getAllKeys(record.id)) await store.delete(key);
		for (const c of credits) {
			await store.put({ ...c, id: creditKey(record.id, c.role, c.personId), mediaId: record.id });
		}
	}
	await tx.done;
}

/** `putMedia` opens three stores per record; an import of a whole library is thousands of transactions. */
export async function putMediaBatch(records: MediaRecord[]): Promise<void> {
	if (records.length === 0) return;
	const db = await openDb();
	const tx = db.transaction(MEDIA_STORES, 'readwrite');
	const mediaStore = tx.objectStore('media');
	const seasonStore = tx.objectStore('seasons');
	const episodeStore = tx.objectStore('episodes');
	const creditStore = tx.objectStore('credits');
	const now = Date.now();

	for (const record of records) {
		const { seasons, episodes, credits, ...scalars } = record;
		await mediaStore.put({ ...scalars, updatedAt: now });
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
		if (credits) {
			for (const key of await creditStore.index('by_media').getAllKeys(record.id)) {
				await creditStore.delete(key);
			}
			for (const c of credits) {
				await creditStore.put({
					...c,
					id: creditKey(record.id, c.role, c.personId),
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

/** Only provider-backed `linked` rows with a known external id, so each result can open its detail page. */
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

/** Linked entries are excluded — the database title they now represent is the one to find. */
export async function searchCustomMedia(query: string, limit = 20): Promise<ClientMedia[]> {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const db = await openDb();
	const linked = new Set(
		(await db.getAll('mediaLinks')).filter((l) => l.targetId !== null).map((l) => l.mediaId)
	);
	return (await getAllMedia())
		.filter((m) => m.source === 'custom' && !linked.has(m.id) && m.title.toLowerCase().includes(q))
		.sort((a, b) => a.title.localeCompare(b.title))
		.slice(0, limit);
}

export async function getSeasons(mediaId: string): Promise<ClientSeason[]> {
	return (await openDb()).getAllFromIndex('seasons', 'by_media', mediaId);
}

export async function getEpisodes(mediaId: string): Promise<ClientEpisode[]> {
	return (await openDb()).getAllFromIndex('episodes', 'by_media', mediaId);
}

/** Ordered by role then billing, as the server returned them. */
export async function getCredits(mediaId: string): Promise<ClientCredit[]> {
	const rows = await (await openDb()).getAllFromIndex('credits', 'by_media', mediaId);
	return rows.sort(
		(a, b) =>
			a.role.localeCompare(b.role) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)
	);
}

export async function getCreditsForPerson(personId: string): Promise<ClientCredit[]> {
	return (await openDb()).getAllFromIndex('credits', 'by_person', personId);
}

/** Tombstones (removed tracking, `watched: false`) don't count; this is also the eviction keep-set. */
export async function getReferencedMediaIds(): Promise<string[]> {
	const db = await openDb();
	const ids = new Set<string>();
	for (const row of await db.getAll('tracking')) if (!row.removed) ids.add(row.mediaId);
	for (const row of await db.getAll('episodeWatches')) if (row.watched) ids.add(row.mediaId);
	return [...ids];
}

/** **Except custom rows, never evicted** — dropping one loses the only copy; nothing can restore it. */
export async function pruneStaleMedia(keepIds: Set<string>): Promise<number> {
	const db = await openDb();
	const tx = db.transaction(MEDIA_STORES, 'readwrite');
	const mediaStore = tx.objectStore('media');
	const seasonStore = tx.objectStore('seasons');
	const episodeStore = tx.objectStore('episodes');
	const creditStore = tx.objectStore('credits');
	const seasonIndex = seasonStore.index('by_media');
	const episodeIndex = episodeStore.index('by_media');
	const creditIndex = creditStore.index('by_media');
	let deleted = 0;

	for (let cursor = await mediaStore.openCursor(); cursor; cursor = await cursor.continue()) {
		if (keepIds.has(cursor.value.id) || cursor.value.source === 'custom') continue;
		const id = cursor.value.id;
		await cursor.delete();
		deleted++;
		for (const key of await seasonIndex.getAllKeys(id)) await seasonStore.delete(key);
		for (const key of await episodeIndex.getAllKeys(id)) await episodeStore.delete(key);
		for (const key of await creditIndex.getAllKeys(id)) await creditStore.delete(key);
	}

	await tx.done;
	return deleted;
}

/** Only `source === 'custom'` rows are erased — a provider-backed row is shared catalog. */
export async function deleteLocalMedia(ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	const db = await openDb();
	const tx = db.transaction([...MEDIA_STORES, 'mediaLinks'], 'readwrite');
	const mediaStore = tx.objectStore('media');
	const seasonStore = tx.objectStore('seasons');
	const episodeStore = tx.objectStore('episodes');
	const creditStore = tx.objectStore('credits');

	for (const id of ids) {
		if ((await mediaStore.get(id))?.source !== 'custom') continue;
		await mediaStore.delete(id);
		for (const key of await seasonStore.index('by_media').getAllKeys(id)) {
			await seasonStore.delete(key);
		}
		for (const key of await episodeStore.index('by_media').getAllKeys(id)) {
			await episodeStore.delete(key);
		}
		for (const key of await creditStore.index('by_media').getAllKeys(id)) {
			await creditStore.delete(key);
		}
		await tx.objectStore('mediaLinks').delete(id);
	}
	await tx.done;
}

/** Custom rows are excluded: the server can't be asked for a title it has never seen. */
export async function getUnsyncedMediaIds(referencedIds: string[]): Promise<string[]> {
	const rows = await Promise.all(referencedIds.map((id) => getMedia(id)));
	return referencedIds.filter((_, i) => {
		const row = rows[i];
		if (row?.source === 'custom') return false;
		return !row || row.version === 0;
	});
}

/** Full scan, not an index: the library is bounded and an index would cost a schema bump for nothing. */
export async function getPendingCustomMedia(limit: number): Promise<CustomMediaPush[]> {
	const db = await openDb();
	const rows = (await db.getAll('media'))
		.filter((m) => m.source === 'custom' && m.pendingPush === 1)
		.sort((a, b) => (a.editedAt ?? 0) - (b.editedAt ?? 0))
		.slice(0, limit);

	return Promise.all(
		rows.map(async (row) => {
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
				genres: row.genres,
				releaseDate: row.releaseDate,
				status: row.status,
				inProduction: row.inProduction,
				firstAirDate: row.firstAirDate,
				lastAirDate: row.lastAirDate,
				version: row.version,
				// The child stores add a composite key and a back-reference; the wire shape has neither.
				seasons: isShow
					? (await getSeasons(row.id)).map((s) => ({
							seasonNumber: s.seasonNumber,
							name: s.name,
							overview: s.overview,
							airDate: s.airDate,
							posterPath: s.posterPath,
							episodeCount: s.episodeCount
						}))
					: null,
				episodes: isShow
					? (await getEpisodes(row.id)).map((e) => ({
							season: e.season,
							episode: e.episode,
							name: e.name,
							overview: e.overview,
							airDate: e.airDate,
							runtime: e.runtime,
							stillPath: e.stillPath
						}))
					: null,
				credits: (await getCredits(row.id)).map((c) => ({
					personId: c.personId,
					externalId: c.externalId,
					name: c.name,
					profilePath: c.profilePath,
					role: c.role,
					character: c.character,
					sortOrder: c.sortOrder
				})),
				// Fall back rather than push a record the server's schema would reject outright.
				editedAt: row.editedAt ?? row.updatedAt
			};
		})
	);
}

/** The one write path for creating or editing a custom entry; stamps the edit clock the server orders by. */
export async function putCustomMedia(
	record: MediaRecord,
	editedAt: number = Date.now()
): Promise<void> {
	await writeMedia(record, { respectPending: false, pending: { editedAt } });
}

export async function clearPendingPush(ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	const db = await openDb();
	const tx = db.transaction('media', 'readwrite');
	const store = tx.objectStore('media');
	for (const id of ids) {
		const row = await store.get(id);
		if (row?.pendingPush === 1) await store.put({ ...row, pendingPush: 0 });
	}
	await tx.done;
}

export interface MediaIdentityRef {
	provider: HydratableProvider;
	externalId: string;
}

/** The version a client holds for a media id (0 when no local row exists). */
export interface MediaVersionEntry {
	id: string;
	version: number;
}

export async function getLinkedMediaRefs(ids: string[]): Promise<MediaIdentityRef[]> {
	const rows = await Promise.all(ids.map((id) => getMedia(id)));
	return rows
		.filter(
			(m): m is ClientMedia =>
				!!m && m.source === 'linked' && m.externalId !== null && isHydratableProvider(m.provider)
		)
		.map((m) => ({
			provider: m.provider as HydratableProvider,
			externalId: m.externalId as string
		}));
}

export async function getMediaVersions(ids: string[]): Promise<MediaVersionEntry[]> {
	return Promise.all(ids.map(async (id) => ({ id, version: (await getMedia(id))?.version ?? 0 })));
}
