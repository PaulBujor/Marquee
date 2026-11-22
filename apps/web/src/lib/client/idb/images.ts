import { openDb, type MediaImages } from './db';

/** An omitted key leaves that image untouched. */
export interface MediaImageBlobs {
	poster?: Blob | null;
	backdrop?: Blob | null;
}

export async function getMediaImages(id: string): Promise<MediaImages | undefined> {
	return (await openDb()).get('mediaImages', id);
}

export async function putMediaImages(id: string, images: MediaImageBlobs): Promise<void> {
	const db = await openDb();
	const existing = await db.get('mediaImages', id);
	await db.put('mediaImages', {
		id,
		poster: images.poster !== undefined ? images.poster : (existing?.poster ?? null),
		backdrop: images.backdrop !== undefined ? images.backdrop : (existing?.backdrop ?? null),
		updatedAt: Date.now()
	});
}

/** Only trimmed under real storage pressure — the tracked set is the offline working set. */
const STORAGE_PRESSURE = 0.8;

/** 0–1, or `null` when the browser can't tell us. */
async function estimateStorageUsage(): Promise<number | null> {
	try {
		if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
		const { usage, quota } = await navigator.storage.estimate();
		if (!quota || usage == null) return null;
		return usage / quota;
	} catch {
		return null;
	}
}

/** Tracked survivors are only trimmed under real storage pressure — images are re-fetchable online. */
export async function pruneMediaImages(
	keepIds: Set<string>,
	maxEntries = 500,
	usage: () => Promise<number | null> = estimateStorageUsage
): Promise<number> {
	const db = await openDb();
	const tx = db.transaction('mediaImages', 'readwrite');
	const store = tx.store;
	let deleted = 0;
	const survivors: { id: string; updatedAt: number }[] = [];

	for (let cursor = await store.openCursor(); cursor; cursor = await cursor.continue()) {
		if (keepIds.has(cursor.value.id)) {
			survivors.push({ id: cursor.value.id, updatedAt: cursor.value.updatedAt });
		} else {
			await cursor.delete();
			deleted++;
		}
	}

	if (survivors.length > maxEntries) {
		const fraction = await usage();
		// Keep every tracked title unless storage is genuinely tight (or unknowable — then enforce).
		if (fraction === null || fraction >= STORAGE_PRESSURE) {
			survivors.sort((a, b) => a.updatedAt - b.updatedAt);
			for (const s of survivors.slice(0, survivors.length - maxEntries)) {
				await store.delete(s.id);
				deleted++;
			}
		}
	}

	await tx.done;
	return deleted;
}
