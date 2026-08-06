import { error, json } from '@sveltejs/kit';
import { and, eq, gt } from 'drizzle-orm';
import { events as eventsTable } from '$lib/server/db/schema';
import { applyEvents } from '$lib/server/sync/projection';
import type { EventEnvelope, ServerEvent } from '$lib/sync/events';
import { syncRequestSchema, SYNC_PAGE_SIZE, type SyncResponse } from '$lib/sync/protocol';
import { problem, zodProblem } from '$lib/server/http/problem';
import { slidingWindow } from '$lib/server/http/rate-limit';
import type { RequestHandler } from './$types';

/**
 * Per-user rate limit on `/api/sync` — best-effort, per-isolate defense-in-depth against a
 * looping/buggy client (Cloudflare's edge rate-limiting is the real backstop). A normal client syncs
 * on triggers plus a 45s interval, well under this; the cap only trips a runaway. In-memory, so it's
 * not shared across isolates and resets on redeploy — that's fine for its purpose.
 */
const SYNC_RATE_WINDOW_MS = 60_000;
const SYNC_RATE_MAX = 60;
const syncHits = new Map<string, number[]>();

/**
 * The sync round trip: push the client's local events and pull everything it's
 * missing since its cursor. Auth-gated (a session-bound user) and idempotent —
 * duplicate pushes dedupe by event id, so MRQ-43's retry/backoff is safe.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');

	// Rate limit per user. Return a bare 429 with `Retry-After` — SvelteKit's `error()` can't attach
	// headers, and the retry hint must stay HTTP-level (not baked into the SyncResponse JSON).
	const { result, kept } = slidingWindow(
		syncHits.get(locals.user.id) ?? [],
		Date.now(),
		SYNC_RATE_WINDOW_MS,
		SYNC_RATE_MAX
	);
	// Drop the key once its window is empty, so the map doesn't retain an entry per user that has
	// ever hit this isolate.
	if (kept.length === 0) syncHits.delete(locals.user.id);
	else syncHits.set(locals.user.id, kept);
	if (result.limited)
		return new Response(null, {
			status: 429,
			headers: { 'Retry-After': String(result.retryAfterSec) }
		});

	// Parse+validate the whole body against the DTO; every issue is collected into a
	// problem+json response rather than failing on the first (server is authoritative).
	const raw: unknown = await request.json().catch(() => undefined);
	if (raw === undefined)
		return problem(400, 'Malformed request body', { detail: 'Body must be valid JSON.' });
	const parsed = syncRequestSchema.safeParse(raw);
	if (!parsed.success) return zodProblem(parsed.error);
	const { cursor, events } = parsed.data;

	await applyEvents(locals.db, locals.user.id, events as EventEnvelope[]);

	// Pull one extra row past the page size to detect whether more remain.
	const rows = await locals.db
		.select()
		.from(eventsTable)
		.where(and(eq(eventsTable.userId, locals.user.id), gt(eventsTable.sequence, cursor)))
		.orderBy(eventsTable.sequence)
		.limit(SYNC_PAGE_SIZE + 1);

	const hasMore = rows.length > SYNC_PAGE_SIZE;
	const page = hasMore ? rows.slice(0, SYNC_PAGE_SIZE) : rows;

	const pulled: ServerEvent[] = page.map((row) => ({
		id: row.id,
		userId: row.userId,
		sequence: row.sequence,
		type: row.type,
		entityId: row.entityId,
		payload: row.payload,
		deviceId: row.deviceId,
		clientCreatedAt: row.clientCreatedAt,
		schemaVersion: row.schemaVersion,
		serverReceivedAt: row.serverReceivedAt.getTime()
	}));

	const response: SyncResponse = {
		cursor: pulled.length > 0 ? pulled[pulled.length - 1].sequence : cursor,
		events: pulled,
		// Ack every id the client sent (including dedup no-ops) so it can clear its outbox.
		applied: events.map((e) => e.id),
		hasMore
	};
	return json(response);
};
