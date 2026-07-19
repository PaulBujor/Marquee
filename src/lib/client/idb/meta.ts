/** `meta` store accessors: the durable `deviceId` and the sync `cursor`. */
import { openDb } from './db';

async function getMeta<T>(key: string): Promise<T | undefined> {
	const db = await openDb();
	const row = await db.get('meta', key);
	return row?.value as T | undefined;
}

async function setMeta(key: string, value: unknown): Promise<void> {
	const db = await openDb();
	await db.put('meta', { key, value });
}

/** Stable per-device id, generated and persisted on first access. */
export async function getDeviceId(): Promise<string> {
	let id = await getMeta<string>('deviceId');
	if (!id) {
		id = crypto.randomUUID();
		await setMeta('deviceId', id);
	}
	return id;
}

/** Highest server `seq` pulled so far (0 = never synced). */
export async function getCursor(): Promise<number> {
	return (await getMeta<number>('cursor')) ?? 0;
}

export async function setCursor(cursor: number): Promise<void> {
	await setMeta('cursor', cursor);
}

/** The signed-in user this store belongs to (used to reset the DB on user switch). */
export async function getUserId(): Promise<string | undefined> {
	return getMeta<string>('userId');
}

export async function setUserId(userId: string): Promise<void> {
	await setMeta('userId', userId);
}
