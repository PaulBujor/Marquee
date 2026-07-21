import { error, json } from '@sveltejs/kit';
import { and, eq, gt } from 'drizzle-orm';
import { events as eventsTable } from '$lib/server/db/schema';
import { applyEvents } from '$lib/server/sync/projection';
import type { EventEnvelope, ServerEvent } from '$lib/sync/events';
import { syncRequestSchema, SYNC_PAGE_SIZE, type SyncResponse } from '$lib/sync/protocol';
import { problem, zodProblem } from '$lib/server/http/problem';
import type { RequestHandler } from './$types';

/**
 * The sync round trip: push the client's local events and pull everything it's
 * missing since its cursor. Auth-gated (a session-bound user) and idempotent —
 * duplicate pushes dedupe by event id, so MRQ-43's retry/backoff is safe.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');

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
		.where(and(eq(eventsTable.userId, locals.user.id), gt(eventsTable.seq, cursor)))
		.orderBy(eventsTable.seq)
		.limit(SYNC_PAGE_SIZE + 1);

	const hasMore = rows.length > SYNC_PAGE_SIZE;
	const page = hasMore ? rows.slice(0, SYNC_PAGE_SIZE) : rows;

	const pulled: ServerEvent[] = page.map((row) => ({
		id: row.id,
		userId: row.userId,
		seq: row.seq,
		type: row.type,
		entityId: row.entityId,
		payload: JSON.parse(row.payload),
		deviceId: row.deviceId,
		clientCreatedAt: row.clientCreatedAt,
		schemaVersion: row.schemaVersion,
		serverReceivedAt: row.serverReceivedAt.getTime()
	}));

	const response: SyncResponse = {
		cursor: pulled.length > 0 ? pulled[pulled.length - 1].seq : cursor,
		events: pulled,
		// Ack every id the client sent (including dedup no-ops) so it can clear its outbox.
		applied: events.map((e) => e.id),
		hasMore
	};
	return json(response);
};
