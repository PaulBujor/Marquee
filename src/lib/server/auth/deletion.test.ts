import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb } from '#lib/server/db/test-db.js';
import {
	adminAudit,
	credits,
	episodes,
	media,
	people,
	seasons,
	sessions,
	tracking,
	users
} from '#lib/server/db/schema.js';
import { deleteUser, deleteUserCascade } from './deletion.js';

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

describe('deleteUser', () => {
	it('removes the account, keeps an audit row that outlives it, and names the address', async () => {
		const db = createTestDb();
		await seed(db);

		expect(await deleteUser(db, actor, 'user-1', '203.0.113.7')).toEqual({
			ok: true,
			email: 'target@example.com'
		});

		expect(await db.select().from(users).where(eq(users.id, 'user-1'))).toHaveLength(0);
		expect(await db.select().from(tracking)).toHaveLength(0);

		const [audit] = await db.select().from(adminAudit);
		expect(audit).toMatchObject({
			actorUserId: 'admin-1',
			action: 'user.purge',
			targetId: 'user-1',
			targetLabel: 'target@example.com',
			ip: '203.0.113.7'
		});
	});

	it('refuses yourself, a missing account and the last admin', async () => {
		const db = createTestDb();
		await seed(db);

		expect(await deleteUser(db, actor, 'admin-1')).toEqual({ ok: false, refusal: 'self' });
		expect(await deleteUser(db, actor, 'nobody')).toEqual({ ok: false, refusal: 'not-found' });

		// admin-1 is the only enabled admin, so deleting it would leave the surface unmanageable.
		expect(await deleteUser(db, { id: 'x', email: 'x@y.z' }, 'admin-1')).toEqual({
			ok: false,
			refusal: 'last-admin'
		});
		expect(await db.select().from(adminAudit)).toHaveLength(0);
	});

	it('allows deleting an admin when another active admin remains', async () => {
		const db = createTestDb();
		await seed(db);
		await db
			.insert(users)
			.values({ id: 'admin-2', email: 'second@example.com', status: 'enabled', role: 'admin' });

		expect(await deleteUser(db, actor, 'admin-2')).toEqual({
			ok: true,
			email: 'second@example.com'
		});
	});
});

describe('deleteUserCascade', () => {
	it('removes every row the account owns and leaves the other account alone', async () => {
		const db = createTestDb();
		await seed(db);

		await deleteUserCascade(db, { id: 'user-1', email: 'target@example.com' });

		for (const table of [sessions, tracking, credits, episodes, seasons, media, people]) {
			expect(await db.select().from(table)).toHaveLength(0);
		}
		expect((await db.select().from(users)).map((row) => row.id)).toEqual(['admin-1']);
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
