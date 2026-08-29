/**
 * `media` store accessors. A {@link MediaRecord} is stored split across three stores mirroring the
 * server: scalar fields in `media`, and (for shows) the nested arrays in `seasons`/`episodes`.
 */
import { openDb, type ClientEpisode, type ClientMedia, type ClientSeason } from './db';
import { isHydratableProvider, type HydratableProvider, type MediaRecord } from '$lib/sync/events';
import type { CustomMediaPush } from '$lib/sync/media-protocol';
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
 *
 * A locally-authored row with an edit still queued for backup is left alone: the incoming copy is
 * by definition the server's, and the server has not seen that edit yet, so applying it would
 * silently discard what the user just typed. The pending copy wins and is pushed on the next cycle.
 */
export async function putMedia(record: MediaRecord): Promise<void> {
	return writeMedia(record, { respectPending: true });
}

/**
 * The write `putMedia` guards. `respectPending: false` is the author's own path — an edit must be
 * able to overwrite an earlier edit that hasn't been pushed yet, which the guard would otherwise
 * block. `pending` carries the backup marker + edit clock through in the same transaction.
 */
async function writeMedia(
	record: MediaRecord,
	opts: { respectPending: boolean; pending?: { editedAt: number } }
): Promise<void> {
	const { seasons, episodes, ...scalars } = record;
	const db = await openDb();
	const tx = db.transaction(['media', 'seasons', 'episodes'], 'readwrite');
	const mediaStore = tx.objectStore('media');
	const existing = await mediaStore.get(record.id);
	if (opts.respectPending && existing?.source === 'custom' && existing.pendingPush === 1) {
		await tx.done;
		return;
	}
	await mediaStore.put({
		// Carry the backup fields forward: an unrelated write (a tracking snapshot, say) must not
		// silently drop the edit clock a later push compares against.
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

/**
 * The user's own authored entries matching a title substring. Separate from
 * {@link searchLocalMedia}, which backs the *offline* fallback for provider-backed titles: these
 * are searchable in every network mode, because nothing upstream has ever heard of them, so this
 * is the only way to reach one.
 */
export async function searchCustomMedia(query: string, limit = 20): Promise<ClientMedia[]> {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	return (await getAllMedia())
		.filter((m) => m.source === 'custom' && m.title.toLowerCase().includes(q))
		.sort((a, b) => a.title.localeCompare(b.title))
		.slice(0, limit);
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
 *
 * **Except custom rows, which are never evicted.** That reasoning rests on the row being
 * re-fetchable, and a user-authored entry isn't: dropping it is the only copy on this device gone,
 * and nothing on the server would bring it back, since recovery is keyed off ids the client can
 * still name. Keeping them also means a removed entry stays findable in search and can be re-added.
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
		if (keepIds.has(cursor.value.id) || cursor.value.source === 'custom') continue;
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
 *
 * A custom row is excluded: nothing on the server can be pulled for a title it has never seen, and
 * asking every cycle for one would keep the light pass permanently non-empty. Backing it up is the
 * push side's job ({@link getPendingCustomMedia}), not the diff's.
 */
export async function getUnsyncedMediaIds(referencedIds: string[]): Promise<string[]> {
	const rows = await Promise.all(referencedIds.map((id) => getMedia(id)));
	return referencedIds.filter((_, i) => {
		const row = rows[i];
		if (row?.source === 'custom') return false;
		return !row || row.version === 0;
	});
}

/**
 * Locally-authored records whose latest edit still needs backing up, as complete push payloads,
 * oldest edit first so a backlog drains in the order it was written.
 *
 * A full scan of `media` rather than an index: the store holds scalars for a bounded library, the
 * sync cycle already scans `tracking` and `episodeWatches` whole, and an index would cost a schema
 * version bump to buy nothing measurable.
 */
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
				// A row can only be pending because an edit stamped the clock, but fall back rather
				// than push a record the server's schema would reject outright.
				editedAt: row.editedAt ?? row.updatedAt
			};
		})
	);
}

/**
 * Write a locally-authored record and mark it for backup, stamping the edit clock the server orders
 * two devices' edits by. The one write path for creating or editing a custom entry.
 */
export async function putCustomMedia(
	record: MediaRecord,
	editedAt: number = Date.now()
): Promise<void> {
	await writeMedia(record, { respectPending: false, pending: { editedAt } });
}

/** Clear the backup marker for records the server reported stored. */
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

/** Provider + external id for a title the server can hydrate. */
export interface MediaIdentityRef {
	provider: HydratableProvider;
	externalId: string;
}

/** The version a client holds for a media id (0 when no local row exists). */
export interface MediaVersionEntry {
	id: string;
	version: number;
}

/** Provider-backed media among `ids` for the media-sync channel. */
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

/** Version-diff report for the media-sync channel. */
export async function getMediaVersions(ids: string[]): Promise<MediaVersionEntry[]> {
	return Promise.all(ids.map(async (id) => ({ id, version: (await getMedia(id))?.version ?? 0 })));
}
