import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { createTestDb } from '$lib/server/db/test-db';
import { users } from '$lib/server/db/schema';
import { upsertSubscription } from '$lib/server/push/subscriptions';
import { GET } from './+server';

type Db = ReturnType<typeof createTestDb>;
type GetEvent = Parameters<typeof GET>[0];

const USER = 'user-1';

function call(db: Db | undefined, user: { id: string } | null): ReturnType<typeof GET> {
	return GET({ locals: { db, user } } as unknown as GetEvent);
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
beforeEach(async () => {
	db = createTestDb();
	await db.insert(users).values({ id: USER, email: 'u1@x.com', status: 'enabled' });
});

describe('GET /api/push/subscriptions', () => {
	it('401s unauthenticated and 503s without a db', async () => {
		expect(await status(() => call(db, null))).toBe(401);
		expect(await status(() => call(undefined, { id: USER }))).toBe(503);
	});

	it('lists the caller’s subscriptions', async () => {
		await upsertSubscription(db, USER, {
			endpoint: 'https://push.example/ep-1',
			keys: { p256dh: 'p256', auth: 'authsecret' },
			deviceId: 'device-1',
			deviceLabel: 'Chrome on Windows'
		});
		const res = await call(db, { id: USER });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { subscriptions: { deviceLabel: string }[] };
		expect(body.subscriptions).toHaveLength(1);
		expect(body.subscriptions[0].deviceLabel).toBe('Chrome on Windows');
	});
});
