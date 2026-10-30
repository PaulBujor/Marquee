import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '#lib/server/db/test-db.js';
import { adminAudit, sessions, users } from '#lib/server/db/schema.js';
import { blockUser, enableUser } from './users.js';

type Db = ReturnType<typeof createTestDb>;

const actor = { id: 'admin-1', email: 'admin@example.com' };

async function seed(db: Db) {
	await db
		.insert(users)
		.values({ id: 'admin-1', email: 'admin@example.com', status: 'enabled', role: 'admin' });
	await db
		.insert(users)
		.values({ id: 'user-1', email: 'target@example.com', status: 'enabled', role: 'user' });
	await db
		.insert(sessions)
		.values({ id: 'sess-1', userId: 'user-1', expiresAt: new Date(Date.now() + 86_400_000) });
	await db
		.insert(sessions)
		.values({ id: 'sess-2', userId: 'admin-1', expiresAt: new Date(Date.now() + 86_400_000) });
}

describe('blockUser', () => {
	it('blocks, records the reason, and audits it', async () => {
		const db = createTestDb();
		await seed(db);

		const result = await blockUser(db, actor, 'user-1', 'Chargeback fraud', '203.0.113.9');
		expect(result).toEqual({ ok: true, email: 'target@example.com' });

		const [target] = await db.select().from(users).where(eq(users.id, 'user-1'));
		expect(target.status).toBe('blocked');
		expect(target.blockedReason).toBe('Chargeback fraud');

		const audit = await db.select().from(adminAudit);
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({
			actorUserId: 'admin-1',
			actorEmail: 'admin@example.com',
			action: 'user.block',
			targetId: 'user-1',
			targetLabel: 'target@example.com',
			reason: 'Chargeback fraud',
			ip: '203.0.113.9'
		});
	});

	it("deletes the target's sessions so an existing cookie stops working", async () => {
		const db = createTestDb();
		await seed(db);

		await blockUser(db, actor, 'user-1', 'Abuse');
		const remaining = await db.select().from(sessions);

		// The admin's own session must survive: clearing every row would sign the acting admin out too.
		expect(remaining.map((row) => row.id)).toEqual(['sess-2']);
	});

	it('refuses to block yourself', async () => {
		const db = createTestDb();
		await seed(db);

		expect(await blockUser(db, actor, 'admin-1', 'Testing')).toEqual({
			ok: false,
			refusal: 'self'
		});
		expect(await db.select().from(adminAudit)).toHaveLength(0);
	});

	it('refuses to block the last active admin', async () => {
		const db = createTestDb();
		await seed(db);
		await db.insert(users).values({
			id: 'admin-2',
			email: 'second@example.com',
			status: 'enabled',
			role: 'admin'
		});

		expect(
			await blockUser(db, { id: 'admin-1', email: 'admin@example.com' }, 'admin-2', 'x')
		).toEqual({ ok: true, email: 'second@example.com' });

		// One active admin is left, so the other is now the last one.
		expect(
			await blockUser(db, { id: 'user-9', email: 'other@example.com' }, 'admin-1', 'nope')
		).toEqual({ ok: false, refusal: 'last-admin' });
	});

	it('reports a missing target', async () => {
		const db = createTestDb();
		await seed(db);

		expect(await blockUser(db, actor, 'nobody', 'reason')).toEqual({
			ok: false,
			refusal: 'not-found'
		});
	});
});

describe('enableUser', () => {
	async function seedPending(db: Db) {
		await db
			.insert(users)
			.values({ id: 'admin-1', email: 'admin@example.com', status: 'enabled', role: 'admin' });
		await db
			.insert(users)
			.values({ id: 'wait-1', email: 'waiting@example.com', status: 'pending', role: 'user' });
	}

	it('admits a pending account and audits it', async () => {
		const db = createTestDb();
		await seedPending(db);

		expect(await enableUser(db, actor, 'wait-1', '198.51.100.4')).toEqual({
			ok: true,
			email: 'waiting@example.com'
		});

		const [target] = await db.select().from(users).where(eq(users.id, 'wait-1'));
		expect(target.status).toBe('enabled');

		const audit = await db.select().from(adminAudit);
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({
			actorUserId: 'admin-1',
			action: 'user.enable',
			targetId: 'wait-1',
			targetLabel: 'waiting@example.com',
			ip: '198.51.100.4'
		});
	});

	it('refuses an account that can already sign in', async () => {
		const db = createTestDb();
		await seedPending(db);
		await db.update(users).set({ status: 'enabled' }).where(eq(users.id, 'wait-1'));

		expect(await enableUser(db, actor, 'wait-1')).toEqual({
			ok: false,
			refusal: 'already-enabled'
		});
		expect(await db.select().from(adminAudit)).toHaveLength(0);
	});

	it('sends a blocked account through restore rather than enable', async () => {
		const db = createTestDb();
		await seedPending(db);
		await db.update(users).set({ status: 'blocked' }).where(eq(users.id, 'wait-1'));

		expect(await enableUser(db, actor, 'wait-1')).toEqual({ ok: false, refusal: 'blocked' });
	});

	it('reports a missing target', async () => {
		const db = createTestDb();
		await seedPending(db);

		expect(await enableUser(db, actor, 'nobody')).toEqual({ ok: false, refusal: 'not-found' });
	});
});
