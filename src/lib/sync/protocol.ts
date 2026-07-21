/**
 * Wire contract for the `POST /api/sync` endpoint — client-safe, shared by the
 * endpoint and (later, MRQ-43) the client sync engine. A single round trip both
 * pushes local events and pulls everything the client is missing since its cursor.
 */
import { z } from 'zod';
import {
	cachedMediaSchema,
	eventEnvelopeSchema,
	type CachedMedia,
	type EventEnvelope,
	type ServerEvent
} from './events';

/** Max events returned in one pull; the client loops on `hasMore` until drained. */
export const SYNC_PAGE_SIZE = 500;

/** Max events (and media sidecar rows) accepted in one push, to bound work per invocation. */
export const SYNC_MAX_PUSH = 1000;

/** DTO for the `POST /api/sync` request body — the server parses against this authoritatively. */
export const syncRequestSchema = z.object({
	deviceId: z.string().min(1),
	cursor: z.number().int().nonnegative(),
	events: z.array(eventEnvelopeSchema).max(SYNC_MAX_PUSH),
	// Reference data, not events: the media the pushed events refer to, so the server can
	// cache it for offline render. Defaults to none for a pull-only sync.
	media: z.array(cachedMediaSchema).max(SYNC_MAX_PUSH).default([])
});

export interface SyncRequest {
	deviceId: string;
	/** Highest server `sequence` the client already holds; pull returns events after it. */
	cursor: number;
	/** Local unsynced events to push. May be empty for a pull-only sync. */
	events: EventEnvelope[];
	/** Media reference data for the pushed events (the catalog cache the server seeds). */
	media: CachedMedia[];
}

export interface SyncResponse {
	/** New cursor — the `sequence` of the last returned event, or the request cursor if none. */
	cursor: number;
	/** Events with `sequence > request.cursor`, ascending, capped at {@link SYNC_PAGE_SIZE}. */
	events: ServerEvent[];
	/** Ids the server accepted (including dedup no-ops) — the client clears these from its outbox. */
	applied: string[];
	/** True when the page was capped and another pull is needed. */
	hasMore: boolean;
}
