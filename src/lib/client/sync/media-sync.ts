/**
 * Client half of the media reference channel. Two cadences: **light** (every cycle, only ids with
 * no local copy — empty in steady state) and **Full** (every referenced id's version, slower).
 * Also pushes user-authored custom media. Runs after event sync.
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

/** Validate local custom records against the wire schema; skip malformed ones with a warning. */
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
 * Hard cap on drain iterations. `25 * MEDIA_SYNC_MAX` covers a 12,500-title library. Past that,
 * the loop exits and reports the leftover via `truncated`.
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
		// Clear backup markers before applying: `putMedia` refuses to overwrite a row still marked pending.
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
