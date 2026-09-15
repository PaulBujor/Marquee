/**
 * Fetches poster + backdrop image bytes for cached media and stores them as Blobs in IndexedDB,
 * so tracked titles render with zero network and an offline export carries the artwork. Runs
 * after the media sync; bounded per run so a large list fills in over several cycles.
 */
import { getAllMedia } from '$lib/client/idb';
import { getMediaImages, putMediaImages, type MediaImageBlobs } from '$lib/client/idb/images';
import { isAuthFailure, SessionExpiredError } from '$lib/client/session';
import { proxiedImageUrl, BACKDROP_SIZE, POSTER_SIZE } from '$lib/media';
import { fetchWithTimeout } from '$lib/resilience';

/** Wall-clock budget per image. Best-effort channel, so a stall just skips that image this cycle. */
const IMAGE_TIMEOUT_MS = 20_000;

/** Max titles whose images are fetched in one run (a big list fills in over several cycles). */
export const IMAGE_SYNC_MAX = 12;

async function fetchBlob(fetchFn: typeof fetch, url: string): Promise<Blob | null> {
	try {
		const res = await fetchWithTimeout(url, { timeoutMs: IMAGE_TIMEOUT_MS }, fetchFn);
		if (!res.ok) {
			if (isAuthFailure(res.status)) throw new SessionExpiredError('image-sync');
			console.warn(`image sync: fetch ${res.status} for ${url}`);
			return null;
		}
		const blob = await res.blob();
		return blob.size > 0 ? blob : null;
	} catch (err) {
		if (err instanceof SessionExpiredError) throw err;
		// A network throw here is usually just offline — expected for a best-effort channel, stay quiet.
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
