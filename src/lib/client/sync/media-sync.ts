/**
 * The media reference channel's client half: pull metadata for tracked titles this device is
 * missing, and push identity for the ones it has so the server can hydrate them for other
 * devices. Runs after the event sync (media is heavier, so it's a separate call). Testable core.
 */
import { getLinkedMediaRefs, getMediaVersions, putMedia } from '$lib/client/idb';
import {
	MEDIA_SYNC_MAX,
	type MediaSyncRequest,
	type MediaSyncResponse
} from '$lib/sync/media-protocol';

/**
 * Hard cap on drain iterations. The server caps TMDB work per request and sets `pending` when more
 * remains; we loop to drain it, but bound the loop so a title that can't hydrate (bad id, TMDB down)
 * can't spin forever — it just retries on the next natural sync. `ceil(MEDIA_SYNC_MAX / 25)` covers
 * a full 500-ref library drained 25-at-a-time, with a little margin.
 */
export const MAX_DRAIN_ITERATIONS = 25;

export async function runMediaSync(fetchFn: typeof fetch = fetch): Promise<{ applied: number }> {
	let applied = 0;

	// The server caps how much it hydrates per request (CPU-bound); it flags `pending` when a backlog
	// remains, so we loop — re-reading local state each pass (freshly stored rows shrink the backlog)
	// — until it's drained or we hit the iteration cap.
	for (let i = 0; i < MAX_DRAIN_ITERATIONS; i++) {
		const [have, refs] = await Promise.all([getMediaVersions(), getLinkedMediaRefs()]);

		// Report what we have + at which version; the server derives the referenced universe from the
		// event log and returns rows we're missing or behind on (version-diff staleness, MRQ-122). We
		// push identity for our linked rows so the server can hydrate them for other devices.
		const body: MediaSyncRequest = {
			refs: refs.slice(0, MEDIA_SYNC_MAX),
			have: have.slice(0, MEDIA_SYNC_MAX)
		};
		const res = await fetchFn('/api/media/sync', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) throw new Error(`media sync failed: HTTP ${res.status}`);

		const data = (await res.json()) as MediaSyncResponse;
		for (const record of data.media) await putMedia(record);
		applied += data.media.length;

		if (!data.pending) break;
	}

	return { applied };
}
