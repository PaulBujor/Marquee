import { and, eq, sql } from 'drizzle-orm';
import type { createDb } from '#lib/server/db/index.js';
import { sessions, users } from '#lib/server/db/schema.js';
import { auditStatement } from './audit.js';

type Db = ReturnType<typeof createDb>;

export type Actor = { id: string; email: string };

export type BlockRefusal = 'self' | 'not-found' | 'last-admin';

export const BLOCK_REFUSALS: Record<BlockRefusal, string> = {
	self: "You can't block your own account.",
	'not-found': 'That account no longer exists.',
	'last-admin': 'This is the last active admin — promote someone else first.'
};

export async function blockUser(
	db: Db,
	actor: Actor,
	targetId: string,
	reason: string,
	ip?: string | null
): Promise<{ ok: true; email: string } | { ok: false; refusal: BlockRefusal }> {
	if (actor.id === targetId) return { ok: false, refusal: 'self' };

	const [target] = await db
		.select({ id: users.id, email: users.email, role: users.role })
		.from(users)
		.where(eq(users.id, targetId))
		.limit(1);

	if (!target) return { ok: false, refusal: 'not-found' };

	if (target.role === 'admin') {
		const [row] = await db
			.select({ admins: sql<number>`count(*)` })
			.from(users)
			.where(and(eq(users.role, 'admin'), eq(users.status, 'enabled')));
		if (Number(row?.admins ?? 0) <= 1) return { ok: false, refusal: 'last-admin' };
	}

	// Sessions go in this batch, not after it: the status is only checked at sign-in, so a surviving session works until its cookie expires.
	await db.batch([
		db
			.update(users)
			.set({ status: 'blocked', blockedReason: reason, updatedAt: new Date() })
			.where(eq(users.id, targetId)),
		db.delete(sessions).where(eq(sessions.userId, targetId)),
		auditStatement(db, {
			actor,
			action: 'user.block',
			target: { type: 'user', id: target.id, label: target.email },
			reason,
			ip
		})
	]);

	return { ok: true, email: target.email };
}

export type EnableRefusal = 'not-found' | 'already-enabled' | 'blocked';

export const ENABLE_REFUSALS: Record<EnableRefusal, string> = {
	'not-found': 'That account no longer exists.',
	'already-enabled': 'That account can already sign in.',
	blocked: 'That account is blocked — restore it instead, so the block is cleared deliberately.'
};

export async function enableUser(
	db: Db,
	actor: Actor,
	targetId: string,
	ip?: string | null
): Promise<{ ok: true; email: string } | { ok: false; refusal: EnableRefusal }> {
	const [target] = await db
		.select({ id: users.id, email: users.email, status: users.status })
		.from(users)
		.where(eq(users.id, targetId))
		.limit(1);

	if (!target) return { ok: false, refusal: 'not-found' };
	if (target.status === 'enabled') return { ok: false, refusal: 'already-enabled' };
	if (target.status === 'blocked') return { ok: false, refusal: 'blocked' };

	await db.batch([
		db
			.update(users)
			.set({ status: 'enabled', blockedReason: null, updatedAt: new Date() })
			.where(eq(users.id, targetId)),
		auditStatement(db, {
			actor,
			action: 'user.enable',
			target: { type: 'user', id: target.id, label: target.email },
			ip
		})
	]);

	return { ok: true, email: target.email };
}
