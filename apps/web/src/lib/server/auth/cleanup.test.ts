import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '#lib/server/db/test-db.js';
import {
	apiTokens,
	events,
	loginTokens,
	passkeyChallenges,
	sessions,
	users
} from '#lib/server/db/schema.js';
import { hashToken } from './tokens';
import { API_TOKEN_RETENTION_DAYS, purgeExpiredAuth } from './cleanup';

type Db = ReturnType<typeof createTestDb>;

let db: Db;
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PAST_RETENTION = new Date(NOW - (API_TOKEN_RETENTION_DAYS + 1) * DAY);

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

	it('deletes expired passkey challenges and keeps live ones', async () => {
		await db.insert(passkeyChallenges).values([
			{
				id: 'stale',
				challenge: 'stale',
				rpId: 'marquee.test',
				expiresAt: new Date(NOW - HOUR)
			},
			{
				id: 'live',
				challenge: 'live',
				rpId: 'marquee.test',
				expiresAt: new Date(NOW + HOUR)
			}
		]);

		expect(await purgeExpiredAuth(db, NOW)).toMatchObject({ passkeyChallenges: 1 });
		expect((await db.select().from(passkeyChallenges)).map((r) => r.id)).toEqual(['live']);
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
			passkeyChallenges: 0,
			notifications: 0,
			apiTokens: 0
		});
	});
});

describe('purgeExpiredAuth — API tokens', () => {
	async function seedToken(hash: string, stamps: Partial<typeof apiTokens.$inferInsert>) {
		const user = await seedUser(`${hash}@x.com`);
		const [row] = await db
			.insert(apiTokens)
			.values({ userId: user.id, hash, label: hash, scopes: [], ...stamps })
			.returning();
		return row;
	}

	it('deletes a token revoked before the retention window', async () => {
		await seedToken('revoked-old', { revokedAt: PAST_RETENTION });

		expect(await purgeExpiredAuth(db, NOW)).toMatchObject({ apiTokens: 1 });
		expect(await db.select().from(apiTokens)).toEqual([]);
	});

	it('keeps a recently revoked token — the revocation itself is the audit trail', async () => {
		await seedToken('revoked-recent', { revokedAt: new Date(NOW - DAY) });

		expect(await purgeExpiredAuth(db, NOW)).toMatchObject({ apiTokens: 0 });
		expect((await db.select().from(apiTokens)).map((r) => r.hash)).toEqual(['revoked-recent']);
	});

	it('deletes a token that expired before the retention window', async () => {
		await seedToken('expired-old', { expiresAt: PAST_RETENTION });

		expect(await purgeExpiredAuth(db, NOW)).toMatchObject({ apiTokens: 1 });
		expect(await db.select().from(apiTokens)).toEqual([]);
	});

	it('never deletes a live token, whether it has no expiry or one in the future', async () => {
		await seedToken('live-forever', {});
		await seedToken('live-for-now', { expiresAt: new Date(NOW + DAY) });

		expect(await purgeExpiredAuth(db, NOW)).toMatchObject({ apiTokens: 0 });
		expect((await db.select().from(apiTokens)).map((r) => r.hash).sort()).toEqual([
			'live-for-now',
			'live-forever'
		]);
	});

	it("leaves the purged token's events intact, with their attribution nulled", async () => {
		const token = await seedToken('revoked-old', { revokedAt: PAST_RETENTION });
		await db.insert(events).values({
			id: 'e1',
			userId: token.userId,
			sequence: 1,
			type: 'tracking.added',
			entityId: 'media-1',
			payload: { status: 'watching' },
			deviceId: 'device-1',
			origin: 'api',
			apiTokenId: token.id,
			clientCreatedAt: NOW
		});

		expect(await purgeExpiredAuth(db, NOW)).toMatchObject({ apiTokens: 1 });
		const [event] = await db.select().from(events);
		expect(event).toMatchObject({ origin: 'api', apiTokenId: null });
	});
});
