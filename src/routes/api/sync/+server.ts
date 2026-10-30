import { error, json } from '@sveltejs/kit';
import { and, eq, gt } from 'drizzle-orm';
import { events as eventsTable } from '#lib/server/db/schema.js';
import { applyEvents } from '#lib/server/sync/projection.js';
import type { EventEnvelope, ServerEvent } from '#lib/sync/events.js';
import { syncRequestSchema, SYNC_PAGE_SIZE, type SyncResponse } from '#lib/sync/protocol.js';
import { problem, zodProblem } from '#lib/server/http/problem.js';
import { slidingWindow } from '#lib/server/http/rate-limit.js';
import type { RequestHandler } from './$types';

/** Best-effort per-isolate defense-in-depth: Cloudflare's edge rate limiting is the real backstop. */
const SYNC_RATE_WINDOW_MS = 60_000;
const SYNC_RATE_MAX = 60;
const syncHits = new Map<string, number[]>();

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');

	// Bare 429: `error()` can't attach the `Retry-After` header, and the hint must stay HTTP-level.
	const { result, kept } = slidingWindow(
		syncHits.get(locals.user.id) ?? [],
		Date.now(),
		SYNC_RATE_WINDOW_MS,
		SYNC_RATE_MAX
	);
	if (kept.length === 0) syncHits.delete(locals.user.id);
	else syncHits.set(locals.user.id, kept);
	if (result.limited)
		return new Response(null, {
			status: 429,
			headers: { 'Retry-After': String(result.retryAfterSec) }
		});

	// Every issue comes back in one problem+json rather than failing on the first.
	const raw: unknown = await request.json().catch(() => undefined);
	if (raw === undefined)
		return problem(400, 'Malformed request body', { detail: 'Body must be valid JSON.' });
	const parsed = syncRequestSchema.safeParse(raw);
	if (!parsed.success) return zodProblem(parsed.error);
	const { cursor, events } = parsed.data;

	await applyEvents(locals.db, locals.user.id, events as EventEnvelope[]);

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
