import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { createTestDb } from '$lib/server/db/test-db';
import { pushSubscriptions, users } from '$lib/server/db/schema';
import { POST } from './+server';

type Db = ReturnType<typeof createTestDb>;
type PostEvent = Parameters<typeof POST>[0];

const USER = 'user-1';
const BODY = {
	endpoint: 'https://push.example/ep-1',
	keys: { p256dh: 'p256', auth: 'authsecret' },
	deviceId: 'device-1',
	deviceLabel: 'Chrome on Windows',
	timezone: 'Europe/Madrid'
};

function call(
	db: Db | undefined,
	user: { id: string } | null,
	body: unknown
): ReturnType<typeof POST> {
	return POST({
		locals: { db, user },
		request: { json: async () => body }
	} as unknown as PostEvent);
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

describe('POST /api/push/subscribe', () => {
	it('401s when unauthenticated and 503s without a db', async () => {
		expect(await status(() => call(db, null, BODY))).toBe(401);
		expect(await status(() => call(undefined, { id: USER }, BODY))).toBe(503);
	});

	it('stores the subscription and returns 201', async () => {
		const res = await call(db, { id: USER }, BODY);
		expect(res.status).toBe(201);
		const rows = await db.select().from(pushSubscriptions);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			userId: USER,
			endpoint: BODY.endpoint,
			deviceLabel: 'Chrome on Windows',
			timezone: 'Europe/Madrid'
		});
	});

	it('400s on a malformed body', async () => {
		const res = await call(db, { id: USER }, { endpoint: 'http://insecure', keys: {} });
		expect(res.status).toBe(400);
	});
});
