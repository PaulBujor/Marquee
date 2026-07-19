import { error, json } from '@sveltejs/kit';
import { and, eq, gt } from 'drizzle-orm';
import { events as eventsTable } from '$lib/server/db/schema';
import { applyEvents } from '$lib/server/sync/projection';
import { validateEvent, type EventEnvelope, type ServerEvent } from '$lib/sync/events';
import { SYNC_MAX_PUSH, SYNC_PAGE_SIZE, type SyncResponse } from '$lib/sync/protocol';
import type { RequestHandler } from './$types';

/**
 * The sync round trip: push the client's local events and pull everything it's
 * missing since its cursor. Auth-gated (a session-bound user) and idempotent —
 * duplicate pushes dedupe by event id, so MRQ-43's retry/backoff is safe.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');

	const body: unknown = await request.json().catch(() => null);
	if (typeof body !== 'object' || body === null) error(400, 'Invalid body');
	const { deviceId, cursor, events } = body as Record<string, unknown>;

	if (typeof deviceId !== 'string' || deviceId.length === 0) error(400, 'Invalid deviceId');
	if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0) {
		error(400, 'Invalid cursor');
	}
	if (!Array.isArray(events)) error(400, 'Invalid events');
	if (events.length > SYNC_MAX_PUSH) error(400, 'Too many events');

	// Server re-validates every event authoritatively (never trusts the client).
	const validated: EventEnvelope[] = [];
	for (const raw of events) {
		const ev = validateEvent(raw);
		if (!ev) error(400, 'Malformed event');
		validated.push(ev);
	}

	await applyEvents(locals.db, locals.user.id, validated);

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
		applied: validated.map((e) => e.id),
		hasMore
	};
	return json(response);
};
