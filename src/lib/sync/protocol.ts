/**
 * Wire contract for the `POST /api/sync` endpoint — client-safe, shared by the
 * endpoint and (later, MRQ-43) the client sync engine. A single round trip both
 * pushes local events and pulls everything the client is missing since its cursor.
 */
import type { EventEnvelope, ServerEvent } from './events';

/** Max events returned in one pull; the client loops on `hasMore` until drained. */
export const SYNC_PAGE_SIZE = 500;

/** Max events accepted in one push, to bound request size / work per invocation. */
export const SYNC_MAX_PUSH = 1000;

export interface SyncRequest {
	deviceId: string;
	/** Highest server `seq` the client already holds; pull returns events after it. */
	cursor: number;
	/** Local unsynced events to push. May be empty for a pull-only sync. */
	events: EventEnvelope[];
}

export interface SyncResponse {
	/** New cursor — the `seq` of the last returned event, or the request cursor if none. */
	cursor: number;
	/** Events with `seq > request.cursor`, ascending, capped at {@link SYNC_PAGE_SIZE}. */
	events: ServerEvent[];
	/** Ids the server accepted (including dedup no-ops) — the client clears these from its outbox. */
	applied: string[];
	/** True when the page was capped and another pull is needed. */
	hasMore: boolean;
}
