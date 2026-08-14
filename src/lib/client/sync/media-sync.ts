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
 * The channel also carries the one thing that travels *up* it: user-authored media, which no server
 * can hydrate, so this client is the only place it exists until it is pushed. That makes a pending
 * record reason enough to make a request even when the pull side has nothing to ask about.
 *
 * Runs after the event sync (media is heavier, so it's a separate call). Testable core.
 */
import {
	clearPendingPush,
	getLinkedMediaRefs,
	getMediaVersions,
	getPendingCustomMedia,
	getReferencedMediaIds,
	getUnsyncedMediaIds,
	putMedia
} from '$lib/client/idb';
import { reportClientError } from '$lib/client/report-error';
import { fetchWithTimeout } from '$lib/resilience';
import {
	customMediaPushSchema,
	MEDIA_SYNC_CUSTOM_MAX,
	MEDIA_SYNC_MAX,
	type MediaSyncRequest,
	type MediaSyncResponse,
	type ValidatedCustomMedia
} from '$lib/sync/media-protocol';

/**
 * Narrow the local rows to what the contract accepts. The server re-validates and would simply
 * reject a malformed record, but catching it here keeps one bad row from failing nothing visibly
 * and re-queueing forever — it's reported once and the rest of the batch still goes.
 */
function toWirePushes(records: { id: string }[]): ValidatedCustomMedia[] {
	const out: ValidatedCustomMedia[] = [];
	for (const record of records) {
		const parsed = customMediaPushSchema.safeParse(record);
		if (parsed.success) {
			out.push(parsed.data);
			continue;
		}
		const message = `media sync: skipping malformed custom record ${record.id}`;
		console.warn(message, parsed.error.issues);
		reportClientError({ message, source: 'media-sync-custom-invalid', at: Date.now() });
	}
	return out;
}

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
): Promise<{ applied: number; pushed: number; truncated: boolean }> {
	const referencedIds = await getReferencedMediaIds();
	const pendingCustom = toWirePushes(await getPendingCustomMedia(MEDIA_SYNC_CUSTOM_MAX));

	const targetIds =
		referencedIds.length === 0
			? []
			: opts.fullCheck
				? referencedIds
				: await getUnsyncedMediaIds(referencedIds);

	if (targetIds.length === 0 && pendingCustom.length === 0) {
		return { applied: 0, pushed: 0, truncated: false };
	}

	// One empty chunk when there is nothing to diff, so a pure backup still makes its request.
	const queue = targetIds.length > 0 ? chunk(targetIds, MEDIA_SYNC_MAX) : [[]];
	let applied = 0;
	let pushed = 0;
	// Rides the first request only — the push is a fixed set, not something to repeat per chunk.
	let toPush: ValidatedCustomMedia[] = pendingCustom;

	for (let i = 0; i < MAX_DRAIN_ITERATIONS && queue.length > 0; i++) {
		const idsChunk = queue.shift()!;
		const [refs, have] = await Promise.all([
			getLinkedMediaRefs(idsChunk),
			getMediaVersions(idsChunk)
		]);
		const body: MediaSyncRequest = {
			refs,
			have,
			...(toPush.length > 0 ? { custom: toPush } : {})
		};
		const sentCustom = toPush;
		toPush = [];
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
		// Clear the backup markers *before* applying the response: a record the server just stored
		// comes back in `media`, and `putMedia` refuses to overwrite a row still marked pending.
		// Only the ids the server reported are cleared — the rest stay queued for another attempt.
		const storedCustom = data.storedCustom ?? [];
		if (storedCustom.length > 0) await clearPendingPush(storedCustom);
		pushed += sentCustom.length > 0 ? storedCustom.length : 0;

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

	return { applied, pushed, truncated };
}
