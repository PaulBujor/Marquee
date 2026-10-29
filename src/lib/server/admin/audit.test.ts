import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '#lib/server/db/test-db.js';
import { adminAudit, users } from '#lib/server/db/schema.js';
import { auditStatement } from './audit.js';

const actor = { id: 'admin-1', email: 'admin@example.com' };

async function seedUser(db: ReturnType<typeof createTestDb>) {
	await db.insert(users).values({ id: 'user-1', email: 'target@example.com', status: 'pending' });
}

describe('auditStatement', () => {
	it('records the actor, the target and structured detail', async () => {
		const db = createTestDb();
		await db.batch([
			auditStatement(db, {
				actor,
				action: 'user.enable',
				target: { type: 'user', id: 'user-1', label: 'target@example.com' },
				metadata: { from: 'pending', to: 'enabled' },
				ip: '203.0.113.7'
			})
		]);

		const [row] = await db.select().from(adminAudit);
		expect(row.action).toBe('user.enable');
		expect(row.actorUserId).toBe('admin-1');
		expect(row.actorEmail).toBe('admin@example.com');
		expect(row.targetId).toBe('user-1');
		expect(row.targetLabel).toBe('target@example.com');
		expect(row.ip).toBe('203.0.113.7');
		expect(JSON.parse(row.metadata ?? '{}')).toEqual({ from: 'pending', to: 'enabled' });
	});

	it('commits alongside the mutation it describes', async () => {
		const db = createTestDb();
		await seedUser(db);

		await db.batch([
			db.update(users).set({ status: 'enabled' }).where(eq(users.id, 'user-1')),
			auditStatement(db, {
				actor,
				action: 'user.enable',
				target: { type: 'user', id: 'user-1' }
			})
		]);

		const [user] = await db.select().from(users).where(eq(users.id, 'user-1'));
		expect(user.status).toBe('enabled');
		expect(await db.select().from(adminAudit)).toHaveLength(1);
	});

	it('rolls the mutation back when the batch fails', async () => {
		const db = createTestDb();
		await seedUser(db);

		await expect(
			db.batch([
				db.update(users).set({ status: 'enabled' }).where(eq(users.id, 'user-1')),
				// Duplicate primary key: fails at execution, not at prepare time, so the batch itself
				// is what raises and the rollback is what the assertion below observes.
				db.insert(users).values({ id: 'user-1', email: 'duplicate@example.com' })
			])
		).rejects.toThrow();

		const [user] = await db.select().from(users).where(eq(users.id, 'user-1'));
		expect(user.status).toBe('pending');
	});
});
