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

export async function runMediaSync(fetchFn: typeof fetch = fetch): Promise<{ applied: number }> {
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
	return { applied: data.media.length };
}
