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
import { fetchWithTimeout } from '$lib/resilience';
import {
	MEDIA_SYNC_MAX,
	type MediaSyncRequest,
	type MediaSyncResponse
} from '$lib/sync/media-protocol';

/**
 * Hard cap on total requests per `runMediaSync` call. `targetIds` is chunked into
 * `MEDIA_SYNC_MAX`-sized pieces and drained as a FIFO queue: a chunk the server flags `pending`
 * on goes to the *back* of the queue rather than being retried immediately, so it can't starve
 * chunks that haven't had a first request yet. Every chunk gets one request before any chunk
 * gets a second, so coverage is guaranteed as long as `chunks.length <= MAX_DRAIN_ITERATIONS` —
 * `25 * MEDIA_SYNC_MAX` covers a 12,500-title library. Past that, the loop exits and reports the
 * leftover via `truncated` rather than dropping it silently.
 */
export const MAX_DRAIN_ITERATIONS = 25;

/** Wall-clock budget per chunk request, so one stalled connection can't hang the whole drain. */
const MEDIA_SYNC_TIMEOUT_MS = 30_000;

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
		const res = await fetchWithTimeout(
			'/api/media/sync',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				timeoutMs: MEDIA_SYNC_TIMEOUT_MS
			},
			fetchFn
		);
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
