/**
 * The event sync round trip and retry timing — the testable core of the sync engine
 * (`engine.svelte.ts` wraps this with triggers, status, and backoff scheduling).
 */
import {
	applyEventToIdb,
	getDeviceId,
	getCursor,
	getUnsynced,
	markSynced,
	setCursor
} from '$lib/client/idb';
import { fetchWithTimeout } from '$lib/resilience';
import { SYNC_MAX_PUSH, type SyncRequest, type SyncResponse } from '$lib/sync/protocol';

/**
 * Wall-clock budget per sync round trip. Generous — a large push against a slow connection is
 * legitimate — but bounded, because an unbounded stall leaves the engine's in-flight guard set
 * and silently stops every later sync for the life of the tab.
 */
const SYNC_TIMEOUT_MS = 30_000;

/** Thrown when `/api/sync` returns a non-2xx status, so the engine can back off and retry. */
export class SyncError extends Error {
	/**
	 * @param retryAfterMs When the server sent a `Retry-After` (typically with a 429), how long to
	 * wait before retrying — the engine honors this instead of its exponential backoff.
	 */
	constructor(
		readonly status: number,
		readonly retryAfterMs?: number
	) {
		super(`sync failed: HTTP ${status}`);
		this.name = 'SyncError';
	}
}

/**
 * Parse an HTTP `Retry-After` header to milliseconds, supporting **both** forms: delta-seconds
 * (`"120"`) and an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`). Returns undefined when the header
 * is absent or unparseable, and never negative (a past date clamps to 0). `now` is injectable for tests.
 */
export function parseRetryAfter(
	header: string | null,
	now: number = Date.now()
): number | undefined {
	if (header === null) return undefined;
	const trimmed = header.trim();
	if (trimmed === '') return undefined;
	// Delta-seconds: a bare non-negative integer.
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
	// HTTP-date.
	const at = Date.parse(trimmed);
	if (Number.isNaN(at)) return undefined;
	return Math.max(0, at - now);
}

/**
 * A retained snapshot of the last sync failure. Deliberately structured (not just a string) so
 * a future "report a sync problem" affordance has the HTTP status, attempt count, and
 * time to hand — the engine keeps the most recent one on `SyncEngine.lastError`.
 */
export interface SyncErrorInfo {
	message: string;
	/** HTTP status when the failure was a non-2xx `/api/sync` response; undefined otherwise. */
	status?: number;
	/** Retry attempt this failure occurred on (0 = first try). */
	attempt: number;
	/** Epoch ms the failure was recorded. */
	at: number;
}

/** Distil a thrown value into a {@link SyncErrorInfo}, pulling the HTTP status off a {@link SyncError}. */
export function toSyncErrorInfo(err: unknown, attempt: number, at: number): SyncErrorInfo {
	return {
		message: err instanceof Error ? err.message : String(err),
		status: err instanceof SyncError ? err.status : undefined,
		attempt,
		at
	};
}

/**
 * One sync pass: push local unsynced events and pull everything since the cursor, looping
 * until the server has no more pages and the outbox is drained. Idempotent — the server
 * dedupes by event id and merges LWW, so a retry after a failed ack re-pushes safely.
 * `fetchFn` is injectable for tests. Throws {@link SyncError} on a non-ok response.
 */
export async function runSync(
	fetchFn: typeof fetch = fetch
): Promise<{ pushed: number; pulled: number }> {
	const deviceId = await getDeviceId();
	let pushed = 0;
	let pulled = 0;

	// At least one round trip always runs (to learn the cursor); we keep going while the server
	// has more to send, or we just filled a push page (there may be more local events to drain).
	let more: boolean;
	do {
		const cursor = await getCursor();
		const events = await getUnsynced(SYNC_MAX_PUSH);
		const body: SyncRequest = { deviceId, cursor, events };

		const res = await fetchWithTimeout(
			'/api/sync',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				timeoutMs: SYNC_TIMEOUT_MS
			},
			fetchFn
		);
		if (!res.ok) throw new SyncError(res.status, parseRetryAfter(res.headers.get('retry-after')));

		const data = (await res.json()) as SyncResponse;
		if (data.applied.length > 0) await markSynced(data.applied);
		for (const event of data.events) await applyEventToIdb(event);
		if (data.events.length > 0) await setCursor(data.cursor);

		pushed += events.length;
		pulled += data.events.length;

		more = data.hasMore || events.length >= SYNC_MAX_PUSH;
	} while (more);

	return { pushed, pulled };
}
