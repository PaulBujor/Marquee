/**
 * The media reference channel's client half. The client already maintains its own
 * `tracking`/`episodeWatches` projections (mirroring the server's), so it knows what it
 * references and what it's missing without asking the server to recompute that — it sends
 * exactly the ids it needs, bounded per request, rather than everything it holds.
 *
 * Two cadences (see `engine.svelte.ts`, which picks `fullCheck` per cycle):
 *  - **Light** (the common case, every cycle): only ids with no local copy at all — the
 *    server-side hydrate-on-miss path. Empty in steady state, so most cycles make no request.
 *  - **Full** (a slower cadence): every referenced id's version, so a title the nightly cron
 *    refreshed server-side gets pulled down even though the client already had *a* copy.
 *
 * Runs after the event sync (media is heavier, so it's a separate call). Testable core.
 */
import {
	getLinkedMediaRefs,
	getMediaVersions,
	getReferencedMediaIds,
	getUnsyncedMediaIds,
	putMedia
} from '$lib/client/idb';
import {
	MEDIA_SYNC_MAX,
	type MediaSyncRequest,
	type MediaSyncResponse
} from '$lib/sync/media-protocol';

/**
 * Hard cap on drain iterations. The server caps TMDB work per request and sets `pending` when more
 * remains; we loop to drain it, but bound the loop so a title that can't hydrate (bad id, TMDB down)
 * can't spin forever — it just retries on the next natural sync. Now that request-time refresh only
 * ever hydrates titles with no stored row (TTL staleness is cron-only), this only fires on a genuine
 * bulk-missing burst — cold start, a large import, or a big backlog pulled after being offline a
 * long time — not on routine cycles. `ceil(MEDIA_SYNC_MAX / 25)` covers a full 500-ref backlog
 * drained 25-at-a-time, with a little margin.
 */
export const MAX_DRAIN_ITERATIONS = 25;

export async function runMediaSync(
	opts: { fullCheck: boolean } = { fullCheck: false },
	fetchFn: typeof fetch = fetch
): Promise<{ applied: number }> {
	let applied = 0;

	for (let i = 0; i < MAX_DRAIN_ITERATIONS; i++) {
		const referencedIds = await getReferencedMediaIds();
		if (referencedIds.length === 0) break;

		// Light pass: only ids with nothing local yet. Full pass: every referenced id, so a
		// cron-side refresh of something we already have shows up via the version-diff.
		const targetIds = opts.fullCheck ? referencedIds : await getUnsyncedMediaIds(referencedIds);
		if (targetIds.length === 0) break;

		const [refs, have] = await Promise.all([
			getLinkedMediaRefs(targetIds),
			getMediaVersions(targetIds)
		]);
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
