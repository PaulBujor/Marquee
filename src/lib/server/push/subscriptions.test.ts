import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/db/test-db';
import { pushSubscriptions, users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import {
	deleteSubscription,
	listSubscriptions,
	pushSubscribeSchema,
	upsertSubscription
} from './subscriptions';

type Db = ReturnType<typeof createTestDb>;

const USER = 'user-1';
const OTHER = 'user-2';

function input(over: Partial<Parameters<typeof upsertSubscription>[2]> = {}) {
	return {
		endpoint: 'https://push.example/ep-1',
		keys: { p256dh: 'p256', auth: 'authsecret' },
		deviceId: 'device-1',
		...over
	};
}

let db: Db;
beforeEach(async () => {
	db = createTestDb();
	await db.insert(users).values({ id: USER, email: 'u1@x.com', status: 'enabled' });
	await db.insert(users).values({ id: OTHER, email: 'u2@x.com', status: 'enabled' });
});

describe('pushSubscribeSchema', () => {
	it('accepts a well-formed subscription with optional fields', () => {
		const parsed = pushSubscribeSchema.safeParse(
			input({ deviceLabel: 'Chrome', timezone: 'Europe/Madrid' })
		);
		expect(parsed.success).toBe(true);
	});

	it('rejects a non-https endpoint and missing keys', () => {
		expect(pushSubscribeSchema.safeParse(input({ endpoint: 'http://insecure/ep' })).success).toBe(
			false
		);
		expect(
			pushSubscribeSchema.safeParse({ ...input(), keys: { p256dh: '', auth: '' } }).success
		).toBe(false);
	});
});

describe('upsertSubscription', () => {
	it('inserts a new subscription', async () => {
		await upsertSubscription(db, USER, input({ timezone: 'Europe/Madrid' }));
		const rows = await db.select().from(pushSubscriptions);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			userId: USER,
			endpoint: 'https://push.example/ep-1',
			p256dh: 'p256',
			auth: 'authsecret',
			deviceId: 'device-1',
			timezone: 'Europe/Madrid'
		});
	});

	it('is idempotent by endpoint — re-subscribing updates in place, not duplicates', async () => {
		await upsertSubscription(db, USER, input({ timezone: 'Europe/Madrid' }));
		await upsertSubscription(
			db,
			USER,
			input({ keys: { p256dh: 'rotated', auth: 'rotated2' }, timezone: 'America/New_York' })
		);
		const rows = await db.select().from(pushSubscriptions);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ p256dh: 'rotated', timezone: 'America/New_York' });
	});
});

describe('deleteSubscription', () => {
	it('deletes the caller-owned row and reports success', async () => {
		await upsertSubscription(db, USER, input());
		const [row] = await db.select().from(pushSubscriptions);
		expect(await deleteSubscription(db, USER, row.id)).toBe(true);
		expect(await db.select().from(pushSubscriptions)).toHaveLength(0);
	});

	it('will not delete another user’s subscription', async () => {
		await upsertSubscription(db, USER, input());
		const [row] = await db.select().from(pushSubscriptions);
		expect(await deleteSubscription(db, OTHER, row.id)).toBe(false);
		expect(
			await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, row.id))
		).toHaveLength(1);
	});
});

describe('listSubscriptions', () => {
	it('returns only the caller’s rows, newest-used first, with epoch-ms timestamps', async () => {
		await upsertSubscription(
			db,
			USER,
			input({ endpoint: 'https://push.example/old', deviceLabel: 'Old' }),
			new Date('2026-07-01T00:00:00Z')
		);
		await upsertSubscription(
			db,
			USER,
			input({ endpoint: 'https://push.example/new', deviceLabel: 'New' }),
			new Date('2026-07-20T00:00:00Z')
		);
		await upsertSubscription(db, OTHER, input({ endpoint: 'https://push.example/other' }));

		const list = await listSubscriptions(db, USER);
		expect(list.map((s) => s.deviceLabel)).toEqual(['New', 'Old']);
		expect(list[0].endpoint).toBe('https://push.example/new');
		expect(typeof list[0].lastUsedAt).toBe('number');
	});
});
