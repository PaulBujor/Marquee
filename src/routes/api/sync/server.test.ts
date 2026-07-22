import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { createTestDb } from '$lib/server/db/test-db';
import { events as eventsTable, users } from '$lib/server/db/schema';
import {
	tmdbMediaId,
	type EventEnvelope,
	type EventPayloadMap,
	type SyncEventType
} from '$lib/sync/events';
import type { SyncRequest, SyncResponse } from '$lib/sync/protocol';
import { POST } from './+server';

type Db = ReturnType<typeof createTestDb>;
type PostEvent = Parameters<typeof POST>[0];

const USER = 'user-1';
const DEVICE = '11111111-1111-1111-1111-111111111111';
const MID = tmdbMediaId('movie', 603);

let uuidCounter = 0;
function nextUuid(): string {
	uuidCounter += 1;
	return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
}

function ev<T extends SyncEventType>(
	type: T,
	payload: EventPayloadMap[T],
	clock: number,
	deviceId = DEVICE
): EventEnvelope<T> {
	return {
		id: nextUuid(),
		type,
		entityId: MID,
		payload,
		deviceId,
		clientCreatedAt: clock,
		schemaVersion: 1
	};
}

function reqEvent(db: Db | undefined, user: { id: string } | null, body: unknown): PostEvent {
	return { locals: { db, user }, request: { json: async () => body } } as unknown as PostEvent;
}

async function post(event: PostEvent): Promise<SyncResponse> {
	const res = await POST(event);
	return (await res.json()) as SyncResponse;
}

async function thrownBy(run: () => unknown): Promise<{ status: number }> {
	try {
		await run();
		throw new Error('expected POST to throw');
	} catch (err) {
		return err as { status: number };
	}
}

let db: Db;
beforeEach(async () => {
	db = createTestDb();
	await db.insert(users).values({ id: USER, email: 'u1@x.com', status: 'enabled' });
});

describe('POST /api/sync guards', () => {
	it('401 without a user', async () => {
		const err = await thrownBy(() =>
			POST(reqEvent(db, null, { deviceId: DEVICE, cursor: 0, events: [] }))
		);
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(401);
	});

	it('503 without a db', async () => {
		const err = await thrownBy(() =>
			POST(reqEvent(undefined, { id: USER }, { deviceId: DEVICE, cursor: 0, events: [] }))
		);
		expect(err.status).toBe(503);
	});

	it('400 problem+json on a malformed event, collecting field errors', async () => {
		const res = await POST(
			reqEvent(db, { id: USER }, { deviceId: DEVICE, cursor: 0, events: [{ type: 'nope' }] })
		);
		expect(res.status).toBe(400);
		expect(res.headers.get('content-type')).toContain('application/problem+json');
		const body = (await res.json()) as { status: number; errors: { field: string }[] };
		expect(body.status).toBe(400);
		expect(body.errors.length).toBeGreaterThan(0);
	});
});

describe('POST /api/sync push + pull', () => {
	it('persists a push and assigns monotonic sequence from 1', async () => {
		const body: SyncRequest = {
			deviceId: DEVICE,
			cursor: 0,
			events: [ev('tracking.added', { status: 'watching' }, 100)]
		};
		const res = await post(reqEvent(db, { id: USER }, body));
		expect(res.applied).toHaveLength(1);
		expect(res.events).toHaveLength(1);
		expect(res.events[0].sequence).toBe(1);
		expect(res.cursor).toBe(1);
		expect(res.hasMore).toBe(false);
	});

	it('dedupes by event id across requests', async () => {
		const e = ev('tracking.status_changed', { status: 'watching' }, 100);
		await post(reqEvent(db, { id: USER }, { deviceId: DEVICE, cursor: 0, events: [e] }));
		const res = await post(
			reqEvent(db, { id: USER }, { deviceId: DEVICE, cursor: 0, events: [e] })
		);
		expect(res.applied).toContain(e.id); // still acknowledged
		expect(await db.select().from(eventsTable)).toHaveLength(1); // but not duplicated
		expect(res.events).toHaveLength(1);
	});

	it('paginates the pull and reports hasMore', async () => {
		const many: EventEnvelope[] = [];
		for (let i = 1; i <= 501; i++) {
			many.push(ev('episode.watched', { season: 1, episode: i }, 1000 + i));
		}
		const first = await post(
			reqEvent(db, { id: USER }, { deviceId: DEVICE, cursor: 0, events: many })
		);
		expect(first.events).toHaveLength(500);
		expect(first.hasMore).toBe(true);
		expect(first.cursor).toBe(500);

		const second = await post(
			reqEvent(db, { id: USER }, { deviceId: DEVICE, cursor: first.cursor, events: [] })
		);
		expect(second.events).toHaveLength(1);
		expect(second.hasMore).toBe(false);
		expect(second.cursor).toBe(501);
	});

	it('resolves a two-device conflict by last-write-wins', async () => {
		const a = ev(
			'tracking.status_changed',
			{ status: 'watching' },
			100,
			'11111111-1111-1111-1111-111111111111'
		);
		const b = ev(
			'tracking.status_changed',
			{ status: 'completed' },
			200,
			'22222222-2222-2222-2222-222222222222'
		);
		await post(reqEvent(db, { id: USER }, { deviceId: a.deviceId, cursor: 0, events: [a] }));
		await post(reqEvent(db, { id: USER }, { deviceId: b.deviceId, cursor: 0, events: [b] }));
		const rows = await db.select().from(eventsTable);
		expect(rows).toHaveLength(2);
		// The newer event (completed@200) wins the materialized status.
		const { tracking } = await import('$lib/server/db/schema');
		const [t] = await db.select().from(tracking);
		expect(t.status).toBe('completed');
	});
});
