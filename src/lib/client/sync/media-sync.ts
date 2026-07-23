/**
 * The media reference channel's client half: pull metadata for tracked titles this device is
 * missing, and push identity for the ones it has so the server can hydrate them for other
 * devices. Runs after the event sync (media is heavier, so it's a separate call). Testable core.
 */
import { getAllMedia, getLinkedMediaRefs, getTracking, putMedia } from '$lib/client/idb';
import {
	MEDIA_SYNC_MAX,
	type MediaSyncRequest,
	type MediaSyncResponse
} from '$lib/sync/media-protocol';

export async function runMediaSync(fetchFn: typeof fetch = fetch): Promise<{ applied: number }> {
	const [tracked, localMedia, refs] = await Promise.all([
		getTracking(),
		getAllMedia(),
		getLinkedMediaRefs()
	]);

	const haveIds = new Set(localMedia.map((m) => m.id));
	const need = tracked.map((t) => t.mediaId).filter((id) => !haveIds.has(id));
	if (need.length === 0 && refs.length === 0) return { applied: 0 };

	const body: MediaSyncRequest = {
		refs: refs.slice(0, MEDIA_SYNC_MAX),
		need: need.slice(0, MEDIA_SYNC_MAX)
	};
	const res = await fetchFn('/api/media/sync', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!res.ok) throw new Error(`media sync failed: HTTP ${res.status}`);

	const data = (await res.json()) as MediaSyncResponse;
	for (const record of data.media) await putMedia(record);
	return { applied: data.media.length };
}
