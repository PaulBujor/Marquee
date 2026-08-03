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
import { reportClientError } from '$lib/client/report-error';
import {
	MEDIA_SYNC_MAX,
	type MediaSyncRequest,
	type MediaSyncResponse
} from '$lib/sync/media-protocol';

/**
 * Hard cap on total requests per `runMediaSync` call. `targetIds` is split into
 * `MEDIA_SYNC_MAX`-sized chunks up front and each chunk gets its own request, queued FIFO — a
 * chunk the server flags `pending` on (more TMDB hydration than it could do in one request) goes
 * to the *back* of the queue rather than being retried immediately, so it can't starve chunks
 * that haven't been visited yet. The queue is drained in full whenever the budget allows: every
 * chunk gets at least one request before any chunk gets a second, so as long as
 * `chunks.length <= MAX_DRAIN_ITERATIONS` the whole referenced set is covered in one call
 * regardless of how it happens to be ordered. `25 * MEDIA_SYNC_MAX` covers a 12,500-title
 * library; past that (or under heavy hydration-retry pressure) the loop still exits cleanly, but
 * reports the leftover instead of dropping it silently — see the `truncated` return.
 */
export const MAX_DRAIN_ITERATIONS = 25;

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

export async function runMediaSync(
	opts: { fullCheck: boolean } = { fullCheck: false },
	fetchFn: typeof fetch = fetch
): Promise<{ applied: number; truncated: boolean }> {
	const referencedIds = await getReferencedMediaIds();
	if (referencedIds.length === 0) return { applied: 0, truncated: false };

	// Light pass: only ids with nothing local yet. Full pass: every referenced id, so a
	// cron-side refresh of something we already have shows up via the version-diff.
	const targetIds = opts.fullCheck ? referencedIds : await getUnsyncedMediaIds(referencedIds);
	if (targetIds.length === 0) return { applied: 0, truncated: false };

	const queue = chunk(targetIds, MEDIA_SYNC_MAX);
	let applied = 0;

	for (let i = 0; i < MAX_DRAIN_ITERATIONS && queue.length > 0; i++) {
		const idsChunk = queue.shift()!;
		const [refs, have] = await Promise.all([
			getLinkedMediaRefs(idsChunk),
			getMediaVersions(idsChunk)
		]);
		const body: MediaSyncRequest = { refs, have };
		const res = await fetchFn('/api/media/sync', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) throw new Error(`media sync failed: HTTP ${res.status}`);

		const data = (await res.json()) as MediaSyncResponse;
		for (const record of data.media) await putMedia(record);
		applied += data.media.length;

		if (data.pending) queue.push(idsChunk);
	}

	const truncated = queue.length > 0;
	if (truncated) {
		const message = `media sync: drain budget exhausted with ${queue.length} chunk(s) (${queue.flat().length} title(s)) still outstanding`;
		console.warn(message);
		reportClientError({ message, source: 'media-sync-truncated', at: Date.now() });
	}

	return { applied, truncated };
}
