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

export async function getLastSyncAt(): Promise<number | null> {
	return (await getMeta('lastSyncAt')) ?? null;
}

export async function setLastSyncAt(at: number): Promise<void> {
	await setMeta('lastSyncAt', at);
}

export async function getLastFullMediaCheck(): Promise<number> {
	return (await getMeta('lastFullMediaCheck')) ?? 0;
}

export async function setLastFullMediaCheck(at: number): Promise<void> {
	await setMeta('lastFullMediaCheck', at);
}

const RECENT_SEARCHES_LIMIT = 25;

export async function getRecentSearches(): Promise<string[]> {
	return (await getMeta('recentSearches')) ?? [];
}

/** Bumps a repeat to the front rather than showing it twice; blank queries are ignored. */
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
