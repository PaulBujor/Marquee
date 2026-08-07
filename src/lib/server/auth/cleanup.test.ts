import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '$lib/server/db/test-db';
import { loginTokens, sessions, users } from '$lib/server/db/schema';
import { hashToken } from './tokens';
import { purgeExpiredAuth } from './cleanup';

type Db = ReturnType<typeof createTestDb>;

let db: Db;
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
	db = createTestDb();
});

async function seedUser(email: string) {
	await db.insert(users).values({ email, status: 'enabled' });
	const [user] = await db.select().from(users).where(eq(users.email, email));
	return user;
}

describe('purgeExpiredAuth', () => {
	it('deletes expired and consumed login tokens, keeping live unconsumed ones', async () => {
		await db.insert(loginTokens).values([
			{
				email: 'live@x.com',
				tokenHash: await hashToken('live'),
				kind: 'link',
				expiresAt: new Date(NOW + HOUR)
			},
			{
				email: 'expired@x.com',
				tokenHash: await hashToken('expired'),
				kind: 'link',
				expiresAt: new Date(NOW - HOUR)
			},
			{
				email: 'consumed@x.com',
				tokenHash: await hashToken('consumed'),
				kind: 'code',
				expiresAt: new Date(NOW + HOUR), // still valid by time, but already used
				consumedAt: new Date(NOW - HOUR)
			}
		]);

		expect(await purgeExpiredAuth(db, NOW)).toMatchObject({ loginTokens: 2 });
		const remaining = await db.select().from(loginTokens);
		expect(remaining.map((r) => r.email)).toEqual(['live@x.com']);
	});

	it('deletes expired sessions, keeping live ones', async () => {
		const user = await seedUser('s@x.com');
		const liveId = await hashToken('live-sess');
		await db.insert(sessions).values([
			{ id: liveId, userId: user.id, expiresAt: new Date(NOW + HOUR) },
			{ id: await hashToken('dead-sess'), userId: user.id, expiresAt: new Date(NOW - HOUR) }
		]);

		expect(await purgeExpiredAuth(db, NOW)).toMatchObject({ sessions: 1 });
		const remaining = await db.select().from(sessions);
		expect(remaining.map((r) => r.id)).toEqual([liveId]);
	});

	it('is a no-op (0/0) when nothing is stale', async () => {
		await db.insert(loginTokens).values({
			email: 'live@x.com',
			tokenHash: await hashToken('live'),
			kind: 'link',
			expiresAt: new Date(NOW + HOUR)
		});
		expect(await purgeExpiredAuth(db, NOW)).toEqual({
			loginTokens: 0,
			sessions: 0,
			notifications: 0
		});
	});
});
