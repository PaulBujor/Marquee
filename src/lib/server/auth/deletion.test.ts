import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb } from '#lib/server/db/test-db.js';
import {
	adminAudit,
	credits,
	episodes,
	loginTokens,
	media,
	people,
	seasons,
	sessions,
	tracking,
	users
} from '#lib/server/db/schema.js';
import { hashToken } from './tokens.js';
import { validateSession } from './session.js';
import { verifyMagicLink } from './index.js';
import {
	DELETION_GRACE_DAYS,
	deleteUserCascade,
	purgeDueUsers,
	softDeleteUser
} from './deletion.js';

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
		.insert(media)
		.values({ id: 'm-1', type: 'movie', title: 'The Matrix', ownerUserId: 'user-1' });
	await db.insert(seasons).values({ mediaId: 'm-1', seasonNumber: 1 });
	await db.insert(episodes).values({ mediaId: 'm-1', seasonNumber: 1, episodeNumber: 1 });
	await db.insert(people).values({ id: 'p-1', name: 'Keanu Reeves', ownerUserId: 'user-1' });
	await db.insert(credits).values({ mediaId: 'm-1', personId: 'p-1', role: 'cast' });
	await db.insert(tracking).values({ id: 't-1', userId: 'user-1', mediaId: 'm-1' });
}

describe('softDeleteUser', () => {
	it('marks the account deleted, kills its sessions and audits it', async () => {
		const db = createTestDb();
		await seed(db);

		expect(await softDeleteUser(db, actor, 'user-1', '203.0.113.5')).toEqual({
			ok: true,
			email: 'target@example.com'
		});

		const [target] = await db.select().from(users).where(eq(users.id, 'user-1'));
		expect(target.deletedAt).toBeInstanceOf(Date);

		// The status stays 'enabled', which is why sign-in and validateSession check deletedAt separately.
		expect(target.status).toBe('enabled');
		expect(await db.select().from(sessions)).toHaveLength(0);

		const [audit] = await db.select().from(adminAudit);
		expect(audit).toMatchObject({
			action: 'user.delete',
			targetId: 'user-1',
			targetLabel: 'target@example.com',
			ip: '203.0.113.5'
		});
	});

	it('refuses yourself, a missing account, an already-deleted one and the last admin', async () => {
		const db = createTestDb();
		await seed(db);

		expect(await softDeleteUser(db, actor, 'admin-1')).toEqual({ ok: false, refusal: 'self' });
		expect(await softDeleteUser(db, actor, 'nobody')).toEqual({ ok: false, refusal: 'not-found' });
		expect(await softDeleteUser(db, actor, 'admin-1')).toEqual({ ok: false, refusal: 'self' });

		// The only other admin is the actor, so deleting admin-1 would leave nobody.
		await db
			.insert(users)
			.values({ id: 'admin-2', email: 'second@example.com', status: 'enabled', role: 'admin' });
		await softDeleteUser(db, actor, 'admin-2');
		expect(await softDeleteUser(db, { id: 'x', email: 'x@y.z' }, 'admin-2')).toEqual({
			ok: false,
			refusal: 'already-deleted'
		});
	});
});

describe('deleteUserCascade', () => {
	it('removes the account and every row it owns, leaving the other account alone', async () => {
		const db = createTestDb();
		await seed(db);

		await deleteUserCascade(db, { id: 'user-1', email: 'target@example.com' });

		for (const table of [sessions, tracking, credits, episodes, seasons, media, people]) {
			expect(await db.select().from(table)).toHaveLength(0);
		}
		const remaining = await db.select().from(users);
		expect(remaining.map((row) => row.id)).toEqual(['admin-1']);
	});

	it('covers every table that carries a user reference', async () => {
		const db = createTestDb();

		const tables = await db.all<{ name: string }>(
			sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
		);
		const withUserColumn: string[] = [];
		for (const { name } of tables) {
			const columns = await db.all<{ name: string }>(sql.raw(`PRAGMA table_info("${name}")`));
			if (columns.some((column) => column.name === 'user_id' || column.name === 'owner_user_id')) {
				withUserColumn.push(name);
			}
		}

		// A new user-owned table fails here until deleteUserCascade learns about it.
		expect(withUserColumn.sort()).toEqual(
			[
				'email_change_tokens',
				'episode_watches',
				'events',
				'media',
				'notification_log',
				'people',
				'push_subscriptions',
				'sessions',
				'share_preview_warms',
				'sync_state',
				'tracking'
			].sort()
		);
	});
});

describe('purgeDueUsers', () => {
	it('leaves accounts inside the grace period alone', async () => {
		const db = createTestDb();
		await seed(db);
		await softDeleteUser(db, actor, 'user-1');

		const justInside = new Date(Date.now() + (DELETION_GRACE_DAYS - 1) * 86_400_000);
		expect(await purgeDueUsers(db, justInside)).toBe(0);
		expect(await db.select().from(users).where(eq(users.id, 'user-1'))).toHaveLength(1);
	});

	it('cascades an account past the grace period and leaves the audit trail behind', async () => {
		const db = createTestDb();
		await seed(db);
		await softDeleteUser(db, actor, 'user-1');

		const past = new Date(Date.now() + (DELETION_GRACE_DAYS + 1) * 86_400_000);
		expect(await purgeDueUsers(db, past)).toBe(1);

		expect(await db.select().from(users).where(eq(users.id, 'user-1'))).toHaveLength(0);
		expect(await db.select().from(tracking)).toHaveLength(0);

		// The purge row and the original soft-delete row both survive the cascade.
		const audit = await db.select().from(adminAudit);
		expect(audit.map((row) => row.action).sort()).toEqual(['user.delete', 'user.purge']);
		expect(audit.find((row) => row.action === 'user.purge')?.targetLabel).toBe(
			'target@example.com'
		);
	});
});

describe('a soft-deleted account', () => {
	it('is refused at sign-in', async () => {
		const db = createTestDb();
		await seed(db);
		const raw = 'magic-link-token-for-test';
		await db.insert(loginTokens).values({
			id: 'lt-1',
			email: 'target@example.com',
			tokenHash: await hashToken(raw),
			kind: 'link',
			expiresAt: new Date(Date.now() + 600_000)
		});
		await softDeleteUser(db, actor, 'user-1');

		expect(await verifyMagicLink(db, raw)).toEqual({ ok: false, reason: 'not_allowed' });
	});

	it('loses a session that still exists, even though the status says enabled', async () => {
		const db = createTestDb();
		await seed(db);
		const raw = 'session-token-for-test';
		await db.insert(sessions).values({
			id: await hashToken(raw),
			userId: 'user-1',
			expiresAt: new Date(Date.now() + 86_400_000)
		});

		expect((await validateSession(db, raw))?.user.id).toBe('user-1');

		// Sets the flag without the session cleanup, so this exercises the deletedAt check itself.
		await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, 'user-1'));

		expect(await validateSession(db, raw)).toBeNull();
		expect(
			await db
				.select()
				.from(sessions)
				.where(eq(sessions.id, await hashToken(raw)))
		).toHaveLength(0);
	});
});
