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
