import {
	applyEventToIdb,
	getDeviceId,
	getCursor,
	getUnsynced,
	markSynced,
	setCursor
} from '#lib/client/idb/index.js';
import { assertAuthed } from '#lib/client/session.js';
import { fetchWithTimeout } from '#lib/resilience.js';
import { SYNC_MAX_PUSH, type SyncRequest, type SyncResponse } from '#lib/sync/protocol.js';

/**
 * Bounded because an unbounded stall leaves the engine's in-flight guard set and silently stops
 * every later sync for the life of the tab.
 */
const SYNC_TIMEOUT_MS = 30_000;

export class SyncError extends Error {
	/**
	 * @param retryAfterMs The engine honours `Retry-After` instead of its exponential backoff.
	 */
	constructor(
		readonly status: number,
		readonly retryAfterMs?: number
	) {
		super(`sync failed: HTTP ${status}`);
		this.name = 'SyncError';
	}
}

/** Supports both header forms; a past HTTP-date clamps to 0. */
export function parseRetryAfter(
	header: string | null,
	now: number = Date.now()
): number | undefined {
	if (header === null) return undefined;
	const trimmed = header.trim();
	if (trimmed === '') return undefined;
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
	const at = Date.parse(trimmed);
	if (Number.isNaN(at)) return undefined;
	return Math.max(0, at - now);
}

/** Structured so a "report a sync problem" affordance has the status, attempt and time to hand. */
export interface SyncErrorInfo {
	message: string;
	status?: number;
	/** Retry attempt this failure occurred on (0 = first try). */
	attempt: number;
	/** Epoch ms. */
	at: number;
}

export function toSyncErrorInfo(err: unknown, attempt: number, at: number): SyncErrorInfo {
	return {
		message: err instanceof Error ? err.message : String(err),
		status: err instanceof SyncError ? err.status : undefined,
		attempt,
		at
	};
}

/**
 * Idempotent — the server dedupes by event id and merges LWW, so a retry after a failed ack
 * re-pushes safely. `fetchFn` is injectable for tests.
 */
export async function runSync(
	fetchFn: typeof fetch = fetch
): Promise<{ pushed: number; pulled: number }> {
	const deviceId = await getDeviceId();
	let pushed = 0;
	let pulled = 0;

	// At least one round trip always runs, to learn the cursor; then while the server has more to
	// send or a full push page was drained.
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
		if (!res.ok) {
			assertAuthed(res, 'sync');
			throw new SyncError(res.status, parseRetryAfter(res.headers.get('retry-after')));
		}

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
