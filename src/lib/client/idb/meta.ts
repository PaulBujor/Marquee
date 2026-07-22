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

/** The signed-in user this store belongs to (used to reset the DB on user switch). */
export async function getUserId(): Promise<string | undefined> {
	return getMeta('userId');
}

export async function setUserId(userId: string): Promise<void> {
	await setMeta('userId', userId);
}
