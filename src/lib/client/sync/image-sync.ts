/**
 * Fetches poster + backdrop image bytes for cached media and stores them as Blobs in IndexedDB,
 * so tracked titles render with zero network and an offline export carries the artwork. Runs
 * after the media sync; bounded per run so a large list fills in over several cycles.
 */
import { getAllMedia } from '$lib/client/idb';
import { getMediaImages, putMediaImages, type MediaImageBlobs } from '$lib/client/idb/images';
import { BACKDROP_SIZE, POSTER_SIZE, proxiedImageUrl } from '$lib/media';

/** Max titles whose images are fetched in one run (a big list fills in over several cycles). */
export const IMAGE_SYNC_MAX = 12;

async function fetchBlob(fetchFn: typeof fetch, url: string): Promise<Blob | null> {
	try {
		const res = await fetchFn(url);
		if (!res.ok) return null;
		const blob = await res.blob();
		return blob.size > 0 ? blob : null;
	} catch {
		return null;
	}
}

export async function runImageSync(fetchFn: typeof fetch = fetch): Promise<{ stored: number }> {
	const media = await getAllMedia();
	let stored = 0;
	let processed = 0;

	for (const m of media) {
		if (processed >= IMAGE_SYNC_MAX) break;
		const cached = await getMediaImages(m.id);
		const needPoster = m.posterPath !== null && !cached?.poster;
		const needBackdrop = m.backdropPath !== null && !cached?.backdrop;
		if (!needPoster && !needBackdrop) continue;

		processed++;
		const updates: MediaImageBlobs = {};
		if (needPoster) {
			const blob = await fetchBlob(fetchFn, proxiedImageUrl(m.posterPath, POSTER_SIZE)!);
			if (blob) updates.poster = blob;
		}
		if (needBackdrop) {
			const blob = await fetchBlob(fetchFn, proxiedImageUrl(m.backdropPath, BACKDROP_SIZE)!);
			if (blob) updates.backdrop = blob;
		}
		if (updates.poster || updates.backdrop) {
			await putMediaImages(m.id, updates);
			stored++;
		}
	}

	return { stored };
}
