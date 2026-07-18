import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '$lib/server/db/test-db';
import { loginTokens, sessions, users } from '$lib/server/db/schema';
import type { EmailSender } from '$lib/server/email';
import { joinWaitlist, requestSignIn, verifyCode, verifyMagicLink } from './index';
import { createSession, invalidateSession, validateSession } from './session';
import { hashToken } from './tokens';

type Db = ReturnType<typeof createTestDb>;

function fakeSender() {
	const sent: { to: string; subject: string; html: string }[] = [];
	const sender: EmailSender = { send: async (m) => void sent.push(m) };
	return { sender, sent };
}

function linkFromEmail(html: string): string {
	const m = html.match(/token=([^"&\s]+)/);
	if (!m) throw new Error('no link token in email');
	return decodeURIComponent(m[1]);
}

function codeFromEmail(html: string): string {
	const m = html.match(/(\d{6})/);
	if (!m) throw new Error('no code in email');
	return m[1];
}

async function seedUser(db: Db, email: string, status: 'pending' | 'enabled' | 'blocked') {
	await db.insert(users).values({ email, status });
	return (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
}

let db: Db;
beforeEach(() => {
	db = createTestDb();
});

describe('requestSignIn', () => {
	const base = { origin: 'http://localhost', mode: 'browser' as const };

	it('returns "unknown" for an unregistered email and sends nothing', async () => {
		const { sender, sent } = fakeSender();
		expect(await requestSignIn({ db, email: 'nobody@x.com', sender, ...base })).toEqual({
			kind: 'unknown'
		});
		expect(sent).toHaveLength(0);
		expect(await db.select().from(loginTokens)).toHaveLength(0);
	});

	it('returns "blocked"/"waitlisted" for blocked/pending users, no email', async () => {
		await seedUser(db, 'b@x.com', 'blocked');
		await seedUser(db, 'p@x.com', 'pending');
		const { sender, sent } = fakeSender();
		expect((await requestSignIn({ db, email: 'b@x.com', sender, ...base })).kind).toBe('blocked');
		expect((await requestSignIn({ db, email: 'p@x.com', sender, ...base })).kind).toBe(
			'waitlisted'
		);
		expect(sent).toHaveLength(0);
	});

	it('emails a link in browser mode and stores a kind=link token', async () => {
		await seedUser(db, 'e@x.com', 'enabled');
		const { sender, sent } = fakeSender();
		expect(await requestSignIn({ db, email: 'e@x.com', sender, ...base, mode: 'browser' })).toEqual(
			{
				kind: 'sent',
				method: 'link'
			}
		);
		expect(sent[0].html).toContain('/auth/verify?token=');
		const rows = await db.select().from(loginTokens).where(eq(loginTokens.email, 'e@x.com'));
		expect(rows).toHaveLength(1);
		expect(rows[0].kind).toBe('link');
	});

	it('emails a 6-digit code in standalone mode and stores a kind=code token', async () => {
		await seedUser(db, 'e@x.com', 'enabled');
		const { sender, sent } = fakeSender();
		expect(
			await requestSignIn({ db, email: 'e@x.com', sender, ...base, mode: 'standalone' })
		).toEqual({ kind: 'sent', method: 'code' });
		expect(codeFromEmail(sent[0].html)).toMatch(/^\d{6}$/);
		const rows = await db.select().from(loginTokens).where(eq(loginTokens.email, 'e@x.com'));
		expect(rows[0].kind).toBe('code');
	});

	it('normalizes the email before lookup', async () => {
		await seedUser(db, 'mixed@x.com', 'enabled');
		const { sender } = fakeSender();
		expect((await requestSignIn({ db, email: '  Mixed@X.com ', sender, ...base })).kind).toBe(
			'sent'
		);
	});

	it('rate-limits after 5 requests per email', async () => {
		await seedUser(db, 'rl@x.com', 'enabled');
		const { sender } = fakeSender();
		const kinds: string[] = [];
		for (let i = 0; i < 6; i++) {
			kinds.push((await requestSignIn({ db, email: 'rl@x.com', sender, ...base })).kind);
		}
		expect(kinds.slice(0, 5).every((k) => k === 'sent')).toBe(true);
		expect(kinds[5]).toBe('rate_limited');
	});

	it('rate-limits per IP across multiple enabled users', async () => {
		const { sender } = fakeSender();
		for (let u = 0; u < 4; u++) await seedUser(db, `ip${u}@x.com`, 'enabled');
		for (let u = 0; u < 4; u++) {
			for (let i = 0; i < 5; i++) {
				await requestSignIn({ db, email: `ip${u}@x.com`, sender, ...base, ip: '5.5.5.5' });
			}
		}
		await seedUser(db, 'ip4@x.com', 'enabled');
		expect(
			(await requestSignIn({ db, email: 'ip4@x.com', sender, ...base, ip: '5.5.5.5' })).kind
		).toBe('rate_limited');
	});
});

describe('verifyMagicLink', () => {
	const base = { origin: 'http://localhost', mode: 'browser' as const };

	it('consumes a valid link for an enabled user and mints a session', async () => {
		const user = await seedUser(db, 'v@x.com', 'enabled');
		const { sender, sent } = fakeSender();
		await requestSignIn({ db, email: 'v@x.com', sender, ...base });
		const token = linkFromEmail(sent[0].html);

		const result = await verifyMagicLink(db, token);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.user.email).toBe('v@x.com');
		expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(1);
		// single-use
		expect(await verifyMagicLink(db, token)).toEqual({ ok: false, reason: 'invalid' });
	});

	it('rejects an unknown token', async () => {
		expect(await verifyMagicLink(db, 'never-issued')).toEqual({ ok: false, reason: 'invalid' });
	});

	it('rejects an expired link', async () => {
		await db.insert(loginTokens).values({
			email: 'e@x.com',
			tokenHash: await hashToken('expired-raw'),
			kind: 'link',
			expiresAt: new Date(Date.now() - 1000)
		});
		expect(await verifyMagicLink(db, 'expired-raw')).toEqual({ ok: false, reason: 'expired' });
	});

	it('rejects a link whose account is not enabled', async () => {
		await seedUser(db, 'p@x.com', 'pending');
		await db.insert(loginTokens).values({
			email: 'p@x.com',
			tokenHash: await hashToken('pending-raw'),
			kind: 'link',
			expiresAt: new Date(Date.now() + 60_000)
		});
		expect(await verifyMagicLink(db, 'pending-raw')).toEqual({ ok: false, reason: 'not_allowed' });
	});
});

describe('verifyCode', () => {
	const base = { origin: 'http://localhost', mode: 'standalone' as const };

	it('consumes the correct code for an enabled user and mints a session', async () => {
		const user = await seedUser(db, 'c@x.com', 'enabled');
		const { sender, sent } = fakeSender();
		await requestSignIn({ db, email: 'c@x.com', sender, ...base });
		const code = codeFromEmail(sent[0].html);

		const result = await verifyCode(db, 'c@x.com', code);
		expect(result.ok).toBe(true);
		expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(1);
		// single-use
		expect(await verifyCode(db, 'c@x.com', code)).toEqual({ ok: false, reason: 'invalid' });
	});

	it('invalidates a prior code when a new one is requested', async () => {
		await seedUser(db, 'c@x.com', 'enabled');
		const { sender, sent } = fakeSender();
		await requestSignIn({ db, email: 'c@x.com', sender, ...base });
		const first = codeFromEmail(sent[0].html);
		await requestSignIn({ db, email: 'c@x.com', sender, ...base });
		const second = codeFromEmail(sent[1].html);

		// only the newest code works; the previous one was consumed on re-issue
		expect(await verifyCode(db, 'c@x.com', first)).toEqual({ ok: false, reason: 'invalid' });
		expect((await verifyCode(db, 'c@x.com', second)).ok).toBe(true);
	});

	it('rejects a wrong code and counts the attempt', async () => {
		await seedUser(db, 'c@x.com', 'enabled');
		const { sender, sent } = fakeSender();
		await requestSignIn({ db, email: 'c@x.com', sender, ...base });
		const code = codeFromEmail(sent[0].html);
		const wrong = code === '000000' ? '111111' : '000000';

		expect(await verifyCode(db, 'c@x.com', wrong)).toEqual({ ok: false, reason: 'invalid' });
		expect(
			(await db.select().from(loginTokens).where(eq(loginTokens.email, 'c@x.com')))[0].attempts
		).toBe(1);
	});

	it('invalidates the code after too many attempts', async () => {
		await seedUser(db, 'c@x.com', 'enabled');
		const { sender, sent } = fakeSender();
		await requestSignIn({ db, email: 'c@x.com', sender, ...base });
		const code = codeFromEmail(sent[0].html);
		const wrong = code === '000000' ? '111111' : '000000';

		const reasons: string[] = [];
		for (let i = 0; i < 5; i++) {
			const r = await verifyCode(db, 'c@x.com', wrong);
			if (!r.ok) reasons.push(r.reason);
		}
		expect(reasons[4]).toBe('too_many_attempts');
		// even the correct code no longer works — it was invalidated
		expect((await verifyCode(db, 'c@x.com', code)).ok).toBe(false);
	});

	it('rejects an expired code', async () => {
		await seedUser(db, 'c@x.com', 'enabled');
		await db.insert(loginTokens).values({
			email: 'c@x.com',
			tokenHash: await hashToken('654321'),
			kind: 'code',
			expiresAt: new Date(Date.now() - 1000)
		});
		expect(await verifyCode(db, 'c@x.com', '654321')).toEqual({ ok: false, reason: 'expired' });
	});

	it('rejects a code whose account is not enabled', async () => {
		await seedUser(db, 'p@x.com', 'pending');
		await db.insert(loginTokens).values({
			email: 'p@x.com',
			tokenHash: await hashToken('654321'),
			kind: 'code',
			expiresAt: new Date(Date.now() + 60_000)
		});
		expect(await verifyCode(db, 'p@x.com', '654321')).toEqual({ ok: false, reason: 'not_allowed' });
	});
});

describe('joinWaitlist', () => {
	it('creates a pending user, stores the signup IP, and emails a confirmation', async () => {
		const { sender, sent } = fakeSender();
		expect(await joinWaitlist(db, '  New@X.com ', sender, '1.2.3.4')).toEqual({
			kind: 'waitlisted'
		});
		const u = (await db.select().from(users).where(eq(users.email, 'new@x.com')))[0];
		expect(u.status).toBe('pending');
		expect(u.signupIp).toBe('1.2.3.4');
		expect(sent).toHaveLength(1);
	});

	it('returns "already"/"blocked" for existing users without re-emailing', async () => {
		await seedUser(db, 'p@x.com', 'pending');
		await seedUser(db, 'b@x.com', 'blocked');
		const { sender, sent } = fakeSender();
		expect(await joinWaitlist(db, 'p@x.com', sender)).toEqual({ kind: 'already' });
		expect(await joinWaitlist(db, 'b@x.com', sender)).toEqual({ kind: 'blocked' });
		expect(sent).toHaveLength(0);
	});

	it('is best-effort on email failure — the signup still succeeds', async () => {
		const throwing: EmailSender = {
			send: async () => {
				throw new Error('smtp down');
			}
		};
		expect(await joinWaitlist(db, 'be@x.com', throwing, '1.1.1.1')).toEqual({ kind: 'waitlisted' });
		expect((await db.select().from(users).where(eq(users.email, 'be@x.com')))[0].status).toBe(
			'pending'
		);
	});

	it('rate-limits signups per IP', async () => {
		const { sender } = fakeSender();
		const kinds: string[] = [];
		for (let i = 0; i < 11; i++) {
			kinds.push((await joinWaitlist(db, `u${i}@x.com`, sender, '9.9.9.9')).kind);
		}
		expect(kinds.slice(0, 10).every((k) => k === 'waitlisted')).toBe(true);
		expect(kinds[10]).toBe('rate_limited');
	});
});

describe('sessions', () => {
	it('creates and validates a session for an enabled user', async () => {
		const user = await seedUser(db, 'h@x.com', 'enabled');
		const { token } = await createSession(db, user.id);
		expect((await validateSession(db, token))?.user.email).toBe('h@x.com');
	});

	it('returns null for an unknown cookie token', async () => {
		expect(await validateSession(db, 'not-a-session')).toBeNull();
	});

	it('drops and deletes an expired session', async () => {
		const user = await seedUser(db, 's@x.com', 'enabled');
		const raw = 'sess-raw';
		const id = await hashToken(raw);
		await db
			.insert(sessions)
			.values({ id, userId: user.id, expiresAt: new Date(Date.now() - 1000) });
		expect(await validateSession(db, raw)).toBeNull();
		expect(await db.select().from(sessions).where(eq(sessions.id, id))).toHaveLength(0);
	});

	it('drops a session whose user is no longer enabled', async () => {
		const user = await seedUser(db, 'blk@x.com', 'enabled');
		const { token } = await createSession(db, user.id);
		await db.update(users).set({ status: 'blocked' }).where(eq(users.id, user.id));
		expect(await validateSession(db, token)).toBeNull();
	});

	it('slides the expiry forward on a stale-but-valid session', async () => {
		const user = await seedUser(db, 'r@x.com', 'enabled');
		const raw = 'refresh-raw';
		const id = await hashToken(raw);
		const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
		await db.insert(sessions).values({
			id,
			userId: user.id,
			expiresAt: new Date(Date.now() + 60_000),
			createdAt: old,
			lastUsedAt: old
		});
		expect(await validateSession(db, raw)).not.toBeNull();
		const row = (await db.select().from(sessions).where(eq(sessions.id, id)))[0];
		expect(row.lastUsedAt.getTime()).toBeGreaterThan(old.getTime());
	});

	it('invalidateSession removes the session', async () => {
		const user = await seedUser(db, 'lo@x.com', 'enabled');
		const { token } = await createSession(db, user.id);
		await invalidateSession(db, token);
		expect(await validateSession(db, token)).toBeNull();
	});
});
