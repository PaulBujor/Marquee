import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { createTestDb } from '$lib/server/db/test-db';
import { pushSubscriptions, users } from '$lib/server/db/schema';
import { upsertSubscription } from '$lib/server/push/subscriptions';
import { DELETE } from './+server';

type Db = ReturnType<typeof createTestDb>;
type DeleteEvent = Parameters<typeof DELETE>[0];

const USER = 'user-1';
const OTHER = 'user-2';

function call(
	db: Db | undefined,
	user: { id: string } | null,
	id: string
): ReturnType<typeof DELETE> {
	return DELETE({ locals: { db, user }, params: { id } } as unknown as DeleteEvent);
}

async function status(run: () => unknown): Promise<number> {
	try {
		await run();
		throw new Error('expected throw');
	} catch (err) {
		if (isHttpError(err)) return err.status;
		throw err;
	}
}

let db: Db;
let id: string;
beforeEach(async () => {
	db = createTestDb();
	await db.insert(users).values({ id: USER, email: 'u1@x.com', status: 'enabled' });
	await db.insert(users).values({ id: OTHER, email: 'u2@x.com', status: 'enabled' });
	await upsertSubscription(db, USER, {
		endpoint: 'https://push.example/ep-1',
		keys: { p256dh: 'p256', auth: 'authsecret' },
		deviceId: 'device-1'
	});
	[{ id }] = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions);
});

describe('DELETE /api/push/subscriptions/[id]', () => {
	it('401s unauthenticated, 503s without a db', async () => {
		expect(await status(() => call(db, null, id))).toBe(401);
		expect(await status(() => call(undefined, { id: USER }, id))).toBe(503);
	});

	it('deletes the caller-owned subscription (204)', async () => {
		const res = await call(db, { id: USER }, id);
		expect(res.status).toBe(204);
		expect(await db.select().from(pushSubscriptions)).toHaveLength(0);
	});

	it('404s for a non-existent id or another user’s row', async () => {
		expect(await status(() => call(db, { id: USER }, 'no-such-id'))).toBe(404);
		expect(await status(() => call(db, { id: OTHER }, id))).toBe(404);
		expect(await db.select().from(pushSubscriptions)).toHaveLength(1);
	});
});
