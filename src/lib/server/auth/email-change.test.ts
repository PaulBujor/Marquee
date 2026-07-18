import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '$lib/server/db/test-db';
import { emailChangeTokens, loginTokens, sessions, users } from '$lib/server/db/schema';
import type { EmailSender } from '$lib/server/email';
import { deleteAccount } from './index';
import { requestEmailChange, verifyEmailChange } from './email-change';
import { createSession } from './session';
import { hashToken } from './tokens';

type Db = ReturnType<typeof createTestDb>;

function fakeSender() {
	const sent: { to: string; subject: string; html: string }[] = [];
	const sender: EmailSender = { send: async (m) => void sent.push(m) };
	return { sender, sent };
}

function codeFromEmail(html: string): string {
	const m = html.match(/(\d{6})/);
	if (!m) throw new Error('no code in email');
	return m[1];
}

async function seedUser(
	db: Db,
	email: string,
	status: 'pending' | 'enabled' | 'blocked' = 'enabled'
) {
	await db.insert(users).values({ email, status });
	return (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
}

let db: Db;
beforeEach(() => {
	db = createTestDb();
});

describe('requestEmailChange', () => {
	it('emails a code to the new address and stores a token scoped to the user', async () => {
		const user = await seedUser(db, 'me@x.com');
		const { sender, sent } = fakeSender();

		expect(await requestEmailChange({ db, user, newEmail: 'new@x.com', sender })).toEqual({
			kind: 'sent'
		});
		expect(sent).toHaveLength(1);
		expect(sent[0].to).toBe('new@x.com');
		expect(codeFromEmail(sent[0].html)).toMatch(/^\d{6}$/);

		const rows = await db
			.select()
			.from(emailChangeTokens)
			.where(eq(emailChangeTokens.userId, user.id));
		expect(rows).toHaveLength(1);
		expect(rows[0].newEmail).toBe('new@x.com');
	});

	it('normalizes the new email before validating and storing', async () => {
		const user = await seedUser(db, 'me@x.com');
		const { sender } = fakeSender();
		await requestEmailChange({ db, user, newEmail: '  New@X.com ', sender });
		const rows = await db
			.select()
			.from(emailChangeTokens)
			.where(eq(emailChangeTokens.userId, user.id));
		expect(rows[0].newEmail).toBe('new@x.com');
	});

	it('rejects an unchanged email', async () => {
		const user = await seedUser(db, 'me@x.com');
		const { sender, sent } = fakeSender();
		expect((await requestEmailChange({ db, user, newEmail: 'ME@x.com', sender })).kind).toBe(
			'unchanged'
		);
		expect(sent).toHaveLength(0);
	});

	it('rejects an address already used by another account', async () => {
		const user = await seedUser(db, 'me@x.com');
		await seedUser(db, 'taken@x.com');
		const { sender, sent } = fakeSender();
		expect((await requestEmailChange({ db, user, newEmail: 'taken@x.com', sender })).kind).toBe(
			'taken'
		);
		expect(sent).toHaveLength(0);
		expect(await db.select().from(emailChangeTokens)).toHaveLength(0);
	});

	it('rejects a malformed email', async () => {
		const user = await seedUser(db, 'me@x.com');
		const { sender } = fakeSender();
		expect((await requestEmailChange({ db, user, newEmail: 'not-an-email', sender })).kind).toBe(
			'invalid'
		);
	});

	it('supersedes a prior live code when a new one is requested', async () => {
		const user = await seedUser(db, 'me@x.com');
		const { sender, sent } = fakeSender();
		await requestEmailChange({ db, user, newEmail: 'new@x.com', sender });
		const first = codeFromEmail(sent[0].html);
		await requestEmailChange({ db, user, newEmail: 'new@x.com', sender });
		const second = codeFromEmail(sent[1].html);

		expect((await verifyEmailChange({ db, user, code: first })).ok).toBe(false);
		expect((await verifyEmailChange({ db, user, code: second })).ok).toBe(true);
	});

	it('rate-limits after 5 requests', async () => {
		const user = await seedUser(db, 'me@x.com');
		const { sender } = fakeSender();
		const kinds: string[] = [];
		for (let i = 0; i < 6; i++) {
			kinds.push((await requestEmailChange({ db, user, newEmail: 'new@x.com', sender })).kind);
		}
		expect(kinds.slice(0, 5).every((k) => k === 'sent')).toBe(true);
		expect(kinds[5]).toBe('rate_limited');
	});
});

describe('verifyEmailChange', () => {
	it('switches the account email on the correct code and is single-use', async () => {
		const user = await seedUser(db, 'me@x.com');
		const { sender, sent } = fakeSender();
		await requestEmailChange({ db, user, newEmail: 'new@x.com', sender });
		const code = codeFromEmail(sent[0].html);

		expect(await verifyEmailChange({ db, user, code })).toEqual({
			ok: true,
			newEmail: 'new@x.com'
		});
		expect((await db.select().from(users).where(eq(users.id, user.id)))[0].email).toBe('new@x.com');
		// single-use: the same code no longer works
		expect((await verifyEmailChange({ db, user, code })).ok).toBe(false);
	});

	it('rejects a wrong code and counts the attempt', async () => {
		const user = await seedUser(db, 'me@x.com');
		const { sender, sent } = fakeSender();
		await requestEmailChange({ db, user, newEmail: 'new@x.com', sender });
		const code = codeFromEmail(sent[0].html);
		const wrong = code === '000000' ? '111111' : '000000';

		expect(await verifyEmailChange({ db, user, code: wrong })).toEqual({
			ok: false,
			reason: 'invalid'
		});
		expect(
			(await db.select().from(emailChangeTokens).where(eq(emailChangeTokens.userId, user.id)))[0]
				.attempts
		).toBe(1);
		// account email unchanged
		expect((await db.select().from(users).where(eq(users.id, user.id)))[0].email).toBe('me@x.com');
	});

	it('invalidates the code after too many attempts', async () => {
		const user = await seedUser(db, 'me@x.com');
		const { sender, sent } = fakeSender();
		await requestEmailChange({ db, user, newEmail: 'new@x.com', sender });
		const code = codeFromEmail(sent[0].html);
		const wrong = code === '000000' ? '111111' : '000000';

		const reasons: string[] = [];
		for (let i = 0; i < 5; i++) {
			const r = await verifyEmailChange({ db, user, code: wrong });
			if (!r.ok) reasons.push(r.reason);
		}
		expect(reasons[4]).toBe('too_many_attempts');
		// even the correct code no longer works
		expect((await verifyEmailChange({ db, user, code })).ok).toBe(false);
	});

	it('rejects an expired code', async () => {
		const user = await seedUser(db, 'me@x.com');
		await db.insert(emailChangeTokens).values({
			userId: user.id,
			newEmail: 'new@x.com',
			tokenHash: await hashToken('654321'),
			expiresAt: new Date(Date.now() - 1000)
		});
		expect(await verifyEmailChange({ db, user, code: '654321' })).toEqual({
			ok: false,
			reason: 'expired'
		});
	});

	it('rejects if the target address was claimed between request and verify', async () => {
		const user = await seedUser(db, 'me@x.com');
		const { sender, sent } = fakeSender();
		await requestEmailChange({ db, user, newEmail: 'new@x.com', sender });
		const code = codeFromEmail(sent[0].html);
		// someone else grabs the address before the code is entered
		await seedUser(db, 'new@x.com');

		expect(await verifyEmailChange({ db, user, code })).toEqual({ ok: false, reason: 'taken' });
		expect((await db.select().from(users).where(eq(users.id, user.id)))[0].email).toBe('me@x.com');
	});
});

describe('deleteAccount', () => {
	it('removes the user along with their sessions, login tokens and email-change tokens', async () => {
		const user = await seedUser(db, 'gone@x.com');
		await createSession(db, user.id);
		await db.insert(loginTokens).values({
			email: 'gone@x.com',
			tokenHash: await hashToken('abc'),
			kind: 'code',
			expiresAt: new Date(Date.now() + 60_000)
		});
		await db.insert(emailChangeTokens).values({
			userId: user.id,
			newEmail: 'new@x.com',
			tokenHash: await hashToken('123456'),
			expiresAt: new Date(Date.now() + 60_000)
		});

		await deleteAccount(db, user);

		expect(await db.select().from(users).where(eq(users.id, user.id))).toHaveLength(0);
		expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);
		expect(
			await db.select().from(loginTokens).where(eq(loginTokens.email, 'gone@x.com'))
		).toHaveLength(0);
		expect(
			await db.select().from(emailChangeTokens).where(eq(emailChangeTokens.userId, user.id))
		).toHaveLength(0);
	});
});
