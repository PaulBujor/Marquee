import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '#lib/server/db/test-db.js';
import { notificationLog, users } from '#lib/server/db/schema.js';
import { sendWaitlistDigest } from './waitlist-digest.js';

const { sent } = vi.hoisted(() => ({
	sent: [] as { to: string; subject: string; html: string }[]
}));

vi.mock('#lib/server/email/index.js', () => ({
	createEmailSender: () => ({
		send: async (options: { to: string; subject: string; html: string }) => {
			sent.push(options);
		}
	})
}));

type Db = ReturnType<typeof createTestDb>;
const env = {} as Env;

async function seed(db: Db) {
	await db
		.insert(users)
		.values({ id: 'admin-1', email: 'admin@example.com', status: 'enabled', role: 'admin' });
	await db
		.insert(users)
		.values({ id: 'waiter-1', email: 'waiting@example.com', status: 'pending', role: 'user' });
}

describe('sendWaitlistDigest', () => {
	beforeEach(() => {
		sent.length = 0;
	});

	it('does nothing when nobody is waiting', async () => {
		const db = createTestDb();
		await db
			.insert(users)
			.values({ id: 'admin-1', email: 'admin@example.com', status: 'enabled', role: 'admin' });

		expect(await sendWaitlistDigest(db, env)).toMatchObject({ pending: 0, sent: 0 });
		expect(sent).toHaveLength(0);
	});

	it('emails an enabled admin once per waiting account and logs it', async () => {
		const db = createTestDb();
		await seed(db);

		expect(await sendWaitlistDigest(db, env)).toMatchObject({
			pending: 1,
			admins: 1,
			sent: 1,
			skipped: 0
		});
		expect(sent).toHaveLength(1);
		expect(sent[0].to).toBe('admin@example.com');
		expect(sent[0].html).toContain('waiting@example.com');

		const log = await db.select().from(notificationLog);
		expect(log).toHaveLength(1);
		expect(log[0]).toMatchObject({ id: 'waitlist:admin-1:waiter-1', userId: 'admin-1' });
	});

	it('is idempotent — a second run sends nothing', async () => {
		const db = createTestDb();
		await seed(db);
		await sendWaitlistDigest(db, env);
		sent.length = 0;

		expect(await sendWaitlistDigest(db, env)).toMatchObject({ sent: 0, skipped: 1 });
		expect(sent).toHaveLength(0);
	});

	it('sends again for a newly waiting account, naming only that one', async () => {
		const db = createTestDb();
		await seed(db);
		await sendWaitlistDigest(db, env);
		sent.length = 0;

		await db
			.insert(users)
			.values({ id: 'waiter-2', email: 'second@example.com', status: 'pending', role: 'user' });

		expect(await sendWaitlistDigest(db, env)).toMatchObject({ pending: 2, sent: 1 });
		expect(sent).toHaveLength(1);
		expect(sent[0].html).toContain('second@example.com');
		expect(sent[0].html).not.toContain('waiting@example.com');
	});

	it('skips a blocked admin and a non-admin', async () => {
		const db = createTestDb();
		await seed(db);
		await db.insert(users).values({
			id: 'admin-2',
			email: 'blocked-admin@example.com',
			status: 'blocked',
			role: 'admin'
		});
		await db
			.insert(users)
			.values({ id: 'user-2', email: 'plain@example.com', status: 'enabled', role: 'user' });

		await sendWaitlistDigest(db, env);
		expect(sent.map((mail) => mail.to)).toEqual(['admin@example.com']);
	});
});
