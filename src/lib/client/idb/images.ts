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

/**
 * Bound the image cache (MRQ-46): drop blobs for media outside `keepIds` (untracked / removed
 * titles), then, if the survivors still exceed `maxEntries`, evict the least-recently-updated (LRU)
 * — a backstop against unbounded growth (tighter storage quotas on iOS make this matter). Returns
 * how many entries were deleted.
 */
export async function pruneMediaImages(keepIds: Set<string>, maxEntries = 500): Promise<number> {
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
		survivors.sort((a, b) => a.updatedAt - b.updatedAt); // oldest first
		for (const s of survivors.slice(0, survivors.length - maxEntries)) {
			await store.delete(s.id);
			deleted++;
		}
	}

	await tx.done;
	return deleted;
}
