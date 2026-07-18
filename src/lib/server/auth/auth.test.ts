import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '$lib/server/db/test-db';
import { loginTokens, sessions, users } from '$lib/server/db/schema';
import type { EmailSender } from '$lib/server/email';
import { joinWaitlist, requestMagicLink, verifyMagicLink } from './index';
import { createSession, invalidateSession, validateSession } from './session';
import { hashToken } from './tokens';

type Db = ReturnType<typeof createTestDb>;

function fakeSender() {
	const sent: { to: string; subject: string; html: string }[] = [];
	const sender: EmailSender = { send: async (m) => void sent.push(m) };
	return { sender, sent };
}

function tokenFromEmail(html: string): string {
	const m = html.match(/token=([^"&\s]+)/);
	if (!m) throw new Error('no token found in email');
	return decodeURIComponent(m[1]);
}

async function seedUser(db: Db, email: string, status: 'pending' | 'enabled' | 'blocked') {
	await db.insert(users).values({ email, status });
	return (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
}

let db: Db;
beforeEach(() => {
	db = createTestDb();
});

describe('requestMagicLink', () => {
	const base = { origin: 'http://localhost' };

	it('returns "unknown" for an unregistered email and sends nothing', async () => {
		const { sender, sent } = fakeSender();
		expect(await requestMagicLink({ db, email: 'nobody@x.com', sender, ...base })).toEqual({
			kind: 'unknown'
		});
		expect(sent).toHaveLength(0);
		expect(await db.select().from(loginTokens)).toHaveLength(0);
	});

	it('returns "blocked" for a blocked user, no email', async () => {
		await seedUser(db, 'b@x.com', 'blocked');
		const { sender, sent } = fakeSender();
		expect(await requestMagicLink({ db, email: 'b@x.com', sender, ...base })).toEqual({
			kind: 'blocked'
		});
		expect(sent).toHaveLength(0);
	});

	it('returns "waitlisted" for a pending user, no email', async () => {
		await seedUser(db, 'p@x.com', 'pending');
		const { sender, sent } = fakeSender();
		expect(await requestMagicLink({ db, email: 'p@x.com', sender, ...base })).toEqual({
			kind: 'waitlisted'
		});
		expect(sent).toHaveLength(0);
	});

	it('sends a link to an enabled user and records a token', async () => {
		await seedUser(db, 'e@x.com', 'enabled');
		const { sender, sent } = fakeSender();
		expect(await requestMagicLink({ db, email: 'e@x.com', sender, ...base })).toEqual({
			kind: 'sent'
		});
		expect(sent).toHaveLength(1);
		expect(sent[0].to).toBe('e@x.com');
		expect(await db.select().from(loginTokens)).toHaveLength(1);
	});

	it('normalizes the email before lookup', async () => {
		await seedUser(db, 'mixed@x.com', 'enabled');
		const { sender } = fakeSender();
		expect(await requestMagicLink({ db, email: '  Mixed@X.com ', sender, ...base })).toEqual({
			kind: 'sent'
		});
	});

	it('rate-limits after 5 requests per email within the window', async () => {
		await seedUser(db, 'rl@x.com', 'enabled');
		const { sender } = fakeSender();
		const kinds: string[] = [];
		for (let i = 0; i < 6; i++) {
			kinds.push((await requestMagicLink({ db, email: 'rl@x.com', sender, ...base })).kind);
		}
		expect(kinds.slice(0, 5)).toEqual(['sent', 'sent', 'sent', 'sent', 'sent']);
		expect(kinds[5]).toBe('rate_limited');
	});

	it('rate-limits per IP across multiple enabled users', async () => {
		const { sender } = fakeSender();
		for (let u = 0; u < 4; u++) await seedUser(db, `ip${u}@x.com`, 'enabled');
		// 4 users x 5 links = 20 tokens from one IP (the per-IP cap)
		for (let u = 0; u < 4; u++) {
			for (let i = 0; i < 5; i++) {
				await requestMagicLink({
					db,
					email: `ip${u}@x.com`,
					sender,
					origin: 'http://localhost',
					ip: '5.5.5.5'
				});
			}
		}
		await seedUser(db, 'ip4@x.com', 'enabled');
		const result = await requestMagicLink({
			db,
			email: 'ip4@x.com',
			sender,
			origin: 'http://localhost',
			ip: '5.5.5.5'
		});
		expect(result.kind).toBe('rate_limited');
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
		expect(sent[0].to).toBe('new@x.com');
	});

	it('returns "already" for an existing pending/enabled user without re-emailing', async () => {
		await seedUser(db, 'p@x.com', 'pending');
		const { sender, sent } = fakeSender();
		expect(await joinWaitlist(db, 'p@x.com', sender)).toEqual({ kind: 'already' });
		expect(sent).toHaveLength(0);
	});

	it('returns "blocked" for a blocked address', async () => {
		await seedUser(db, 'b@x.com', 'blocked');
		const { sender } = fakeSender();
		expect(await joinWaitlist(db, 'b@x.com', sender)).toEqual({ kind: 'blocked' });
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

describe('verifyMagicLink', () => {
	it('consumes a valid link for an enabled user and mints a session', async () => {
		const user = await seedUser(db, 'v@x.com', 'enabled');
		const { sender, sent } = fakeSender();
		await requestMagicLink({ db, email: 'v@x.com', sender, origin: 'http://localhost' });
		const token = tokenFromEmail(sent[0].html);

		const result = await verifyMagicLink(db, token);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.user.email).toBe('v@x.com');
		expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(1);
	});

	it('rejects a reused (single-use) token', async () => {
		await seedUser(db, 'v@x.com', 'enabled');
		const { sender, sent } = fakeSender();
		await requestMagicLink({ db, email: 'v@x.com', sender, origin: 'http://localhost' });
		const token = tokenFromEmail(sent[0].html);

		await verifyMagicLink(db, token);
		expect(await verifyMagicLink(db, token)).toEqual({ ok: false, reason: 'invalid' });
	});

	it('rejects an unknown token', async () => {
		expect(await verifyMagicLink(db, 'never-issued')).toEqual({ ok: false, reason: 'invalid' });
	});

	it('rejects an expired token', async () => {
		const raw = 'expired-raw';
		await db.insert(loginTokens).values({
			tokenHash: await hashToken(raw),
			email: 'e@x.com',
			expiresAt: new Date(Date.now() - 1000)
		});
		expect(await verifyMagicLink(db, raw)).toEqual({ ok: false, reason: 'expired' });
	});

	it('rejects a token whose account is not enabled (not_allowed)', async () => {
		await seedUser(db, 'p@x.com', 'pending');
		const raw = 'pending-raw';
		await db.insert(loginTokens).values({
			tokenHash: await hashToken(raw),
			email: 'p@x.com',
			expiresAt: new Date(Date.now() + 60_000)
		});
		expect(await verifyMagicLink(db, raw)).toEqual({ ok: false, reason: 'not_allowed' });
	});
});

describe('sessions', () => {
	it('creates and validates a session for an enabled user', async () => {
		const user = await seedUser(db, 'h@x.com', 'enabled');
		const { token } = await createSession(db, user.id);
		const res = await validateSession(db, token);
		expect(res?.user.email).toBe('h@x.com');
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
