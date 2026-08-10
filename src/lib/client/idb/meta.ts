/** `meta` store accessors: the durable `deviceId`, the sync `cursor`, and the owning `userId`. */
import { openDb, type MetaEntry, type MetaKey, type MetaValues } from './db';

async function getMeta<K extends MetaKey>(key: K): Promise<MetaValues[K] | undefined> {
	const db = await openDb();
	const row = await db.get('meta', key);
	return row?.value as MetaValues[K] | undefined;
}

async function setMeta<K extends MetaKey>(key: K, value: MetaValues[K]): Promise<void> {
	const db = await openDb();
	await db.put('meta', { key, value } as MetaEntry);
}

/** Stable per-device id, generated and persisted on first access. */
export async function getDeviceId(): Promise<string> {
	let id = await getMeta('deviceId');
	if (!id) {
		id = crypto.randomUUID();
		await setMeta('deviceId', id);
	}
	return id;
}

/** Highest server `sequence` pulled so far (0 = never synced). */
export async function getCursor(): Promise<number> {
	return (await getMeta('cursor')) ?? 0;
}

export async function setCursor(cursor: number): Promise<void> {
	await setMeta('cursor', cursor);
}

/** Epoch ms of the last successful event sync, or null if never synced on this device. */
export async function getLastSyncAt(): Promise<number | null> {
	return (await getMeta('lastSyncAt')) ?? null;
}

export async function setLastSyncAt(at: number): Promise<void> {
	await setMeta('lastSyncAt', at);
}

/** Epoch ms of the last full media version-diff pass, or 0 if never run on this device. */
export async function getLastFullMediaCheck(): Promise<number> {
	return (await getMeta('lastFullMediaCheck')) ?? 0;
}

export async function setLastFullMediaCheck(at: number): Promise<void> {
	await setMeta('lastFullMediaCheck', at);
}

const RECENT_SEARCHES_LIMIT = 25;

/** Last committed searches, most recent first — empty if none recorded on this device. */
export async function getRecentSearches(): Promise<string[]> {
	return (await getMeta('recentSearches')) ?? [];
}

/**
 * Record a committed search query, bumping it to the front if already present (rather than
 * showing it twice) and capping the list at {@link RECENT_SEARCHES_LIMIT}. Returns the updated
 * list so the caller can update its UI state without a second round trip. Blank queries are
 * ignored — clearing the search box shouldn't add an empty entry.
 */
export async function addRecentSearch(query: string): Promise<string[]> {
	const q = query.trim();
	if (!q) return getRecentSearches();
	const existing = await getRecentSearches();
	const next = [q, ...existing.filter((s) => s !== q)].slice(0, RECENT_SEARCHES_LIMIT);
	await setMeta('recentSearches', next);
	return next;
}

export async function clearRecentSearches(): Promise<void> {
	await setMeta('recentSearches', []);
}
