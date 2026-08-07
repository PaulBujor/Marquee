/** `mediaImages` store accessors — cached poster/backdrop image bytes keyed by our media id. */
import { openDb, type MediaImages } from './db';

/** Image blobs to upsert — either/both artwork kinds; an omitted key leaves that one untouched. */
export interface MediaImageBlobs {
	poster?: Blob | null;
	backdrop?: Blob | null;
}

/** The cached images for a title, or undefined if none fetched yet. */
export async function getMediaImages(id: string): Promise<MediaImages | undefined> {
	return (await openDb()).get('mediaImages', id);
}

/** Upsert one or both image blobs, preserving whichever isn't provided. */
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

/** Evict the tracked (survivor) LRU tail only once storage usage passes this fraction of quota. */
const STORAGE_PRESSURE = 0.8;

/**
 * Report current persistent-storage usage as a fraction of quota (0–1), or `null` when the browser
 * can't tell us (no `navigator.storage.estimate`). Used to decide whether the image cache needs
 * trimming below its soft cap.
 */
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

/**
 * Bound the image cache: always drop blobs for media outside `keepIds` (untracked / removed
 * titles). The still-tracked survivors are the working set we *want* available offline, so they're
 * only trimmed to `maxEntries` (least-recently-updated first) when the device is actually under
 * storage pressure — otherwise a user tracking more than the cap would lose posters they still track
 * for no reason, since the images are re-fetchable when online. When the browser can't
 * report usage, we fall back to enforcing the cap (a conservative backstop). Returns how many
 * entries were deleted. `usage` is injectable for testing.
 */
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
			survivors.sort((a, b) => a.updatedAt - b.updatedAt); // oldest first
			for (const s of survivors.slice(0, survivors.length - maxEntries)) {
				await store.delete(s.id);
				deleted++;
			}
		}
	}

	await tx.done;
	return deleted;
}
