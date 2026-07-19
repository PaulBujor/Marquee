import { and, count, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { createDb } from '$lib/server/db';
import { emailChangeTokens, loginTokens, sessions, users, type User } from '$lib/server/db/schema';
import type { EmailSender } from '$lib/server/email';
import {
	renderCodeEmail,
	renderMagicLinkAndCodeEmail,
	renderWaitlistEmail
} from '$lib/server/email/templates';
import { createSession } from './session';
import { generateCode, generateToken, hashToken } from './tokens';
import { normalizeEmail } from './validation';

type Db = ReturnType<typeof createDb>;

/**
 * A code lives shorter than a link on purpose: a 6-digit code is only ~20 bits
 * of entropy (vs the link token's 256), so a tighter window limits online
 * brute-forcing; a code is also typed straight back into the open app, while a
 * link may detour through an email client on another device.
 */
export const LINK_TTL_MINUTES = 15;
export const CODE_TTL_MINUTES = 10;
const LINK_TTL_MS = LINK_TTL_MINUTES * 60 * 1000;
const CODE_TTL_MS = CODE_TTL_MINUTES * 60 * 1000;
/** Failed code entries before the code is invalidated (online brute-force cap). */
const CODE_MAX_ATTEMPTS = 5;
/** Email-bomb protection: cap sign-in requests per email and per IP within a window. */
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_PER_EMAIL = 5;
const RATE_MAX_PER_IP = 20;
/** Per-IP cap on unauthenticated waitlist signups within RATE_WINDOW_MS. */
const SIGNUP_MAX_PER_IP = 10;

/** Where the sign-in request came from: an installed PWA vs a browser tab. */
export type SignInMode = 'standalone' | 'browser';

/**
 * Outcome of the request phase. Status-gated, so it deliberately reveals account
 * state (enabled / blocked / waitlisted / unknown) — not enumeration-resistant,
 * by design. On success, `method` is what was emailed: a link *and* a code for
 * browsers (click either), a code only for installed PWAs (which can't capture
 * the link).
 */
export type RequestResult =
	| { kind: 'sent'; method: 'code' | 'link_and_code' }
	| { kind: 'blocked' }
	| { kind: 'waitlisted' }
	| { kind: 'unknown' }
	| { kind: 'rate_limited' };

/**
 * Request phase: branch on account status; for an enabled user, email a magic
 * link *and* a 6-digit code (browser) or a code only (PWA) per `mode`. Unknown
 * addresses are invited to join the waitlist (see `joinWaitlist`), not created here.
 */
export async function requestSignIn(opts: {
	db: Db;
	email: string;
	sender: EmailSender;
	origin: string;
	mode: SignInMode;
	ip?: string | null;
}): Promise<RequestResult> {
	const email = normalizeEmail(opts.email);
	const user = (await opts.db.select().from(users).where(eq(users.email, email)).limit(1)).at(0);

	if (!user) return { kind: 'unknown' };
	if (user.status === 'blocked') return { kind: 'blocked' };
	if (user.status === 'pending') return { kind: 'waitlisted' };
	if (await isRateLimited(opts.db, email, opts.ip)) return { kind: 'rate_limited' };

	if (opts.mode === 'standalone') {
		const { code, supersede, insert } = await codeWrites(opts.db, email, opts.ip);
		await opts.db.batch([supersede, insert]);
		await opts.sender.send({
			to: email,
			subject: 'Your Marquee sign-in code',
			html: renderCodeEmail(code, CODE_TTL_MINUTES)
		});
		return { kind: 'sent', method: 'code' };
	}

	// Browser: one email with both, so a user can click the link or type the code.
	const { code, supersede, insert: codeInsert } = await codeWrites(opts.db, email, opts.ip);
	const { url, insert: linkInsert } = await linkWrite(opts.db, email, opts.origin, opts.ip);
	await opts.db.batch([supersede, codeInsert, linkInsert]);
	await opts.sender.send({
		to: email,
		subject: 'Your Marquee sign-in link and code',
		html: renderMagicLinkAndCodeEmail(url, code, LINK_TTL_MINUTES, CODE_TTL_MINUTES)
	});
	return { kind: 'sent', method: 'link_and_code' };
}

/**
 * Build the writes for a fresh 6-digit code (superseding any live one) without
 * running them, so the caller can batch them into a single D1 round-trip. Returns
 * the raw code alongside the supersede + insert statements.
 */
async function codeWrites(db: Db, email: string, ip?: string | null) {
	const code = generateCode();
	const tokenHash = await hashToken(code);
	// Keep at most one live code per email so verify never has to disambiguate
	// between two codes issued in the same second (createdAt is second-resolution).
	const supersede = db
		.update(loginTokens)
		.set({ consumedAt: new Date() })
		.where(
			and(
				eq(loginTokens.email, email),
				eq(loginTokens.kind, 'code'),
				isNull(loginTokens.consumedAt)
			)
		);
	const insert = db.insert(loginTokens).values({
		email,
		tokenHash,
		kind: 'code',
		requestIp: ip ?? null,
		expiresAt: new Date(Date.now() + CODE_TTL_MS)
	});
	return { code, supersede, insert };
}

/**
 * Build the write for a fresh magic-link token without running it (batched by the
 * caller). Returns the sign-in URL alongside the insert statement.
 */
async function linkWrite(db: Db, email: string, origin: string, ip?: string | null) {
	const token = generateToken();
	const insert = db.insert(loginTokens).values({
		email,
		tokenHash: await hashToken(token),
		kind: 'link',
		requestIp: ip ?? null,
		expiresAt: new Date(Date.now() + LINK_TTL_MS)
	});
	return { url: `${origin}/auth/verify?token=${encodeURIComponent(token)}`, insert };
}

export type JoinResult =
	{ kind: 'waitlisted' } | { kind: 'blocked' } | { kind: 'already' } | { kind: 'rate_limited' };

/**
 * Waitlist signup: create a `pending` user for a previously-unknown address and
 * email a confirmation. Unauthenticated, so it's rate-limited per IP to prevent
 * row-flooding / email-bombing. Promotion to `enabled` is a manual DB flip
 * during the private beta.
 */
export async function joinWaitlist(
	db: Db,
	rawEmail: string,
	sender: EmailSender,
	ip?: string | null
): Promise<JoinResult> {
	const email = normalizeEmail(rawEmail);
	const existing = (await db.select().from(users).where(eq(users.email, email)).limit(1)).at(0);
	if (existing) {
		return existing.status === 'blocked' ? { kind: 'blocked' } : { kind: 'already' };
	}

	if (ip) {
		const [{ n }] = await db
			.select({ n: count() })
			.from(users)
			.where(
				and(eq(users.signupIp, ip), gte(users.createdAt, new Date(Date.now() - RATE_WINDOW_MS)))
			);
		if (n >= SIGNUP_MAX_PER_IP) return { kind: 'rate_limited' };
	}

	await db
		.insert(users)
		.values({ email, status: 'pending', signupIp: ip ?? null })
		.onConflictDoNothing();
	// Confirmation email is best-effort — the signup already succeeded, so a send
	// failure must not fail the request.
	try {
		await sender.send({
			to: email,
			subject: "You're on the Marquee waitlist",
			html: renderWaitlistEmail()
		});
	} catch (err) {
		console.error('waitlist confirmation email failed:', err);
	}
	return { kind: 'waitlisted' };
}

export type VerifyResult =
	| { ok: true; user: User; token: string; expiresAt: Date }
	| { ok: false; reason: 'invalid' | 'expired' | 'not_allowed' | 'too_many_attempts' };

/**
 * Verify a magic link (browser flow): validate and consume the token, then mint
 * a session for the enabled user. Single-use — consumption is atomic.
 */
export async function verifyMagicLink(db: Db, rawToken: string): Promise<VerifyResult> {
	const tokenHash = await hashToken(rawToken);
	const row = (
		await db
			.select()
			.from(loginTokens)
			.where(and(eq(loginTokens.tokenHash, tokenHash), eq(loginTokens.kind, 'link')))
			.limit(1)
	).at(0);

	if (!row || row.consumedAt) return { ok: false, reason: 'invalid' };
	if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

	return consumeAndMint(db, row.id, row.email);
}

/**
 * Verify a 6-digit code (PWA flow): match the code against the latest unused
 * code for the email, minting a session for the enabled user. Single-use;
 * failed attempts are counted and the code is invalidated past the cap.
 */
export async function verifyCode(db: Db, rawEmail: string, code: string): Promise<VerifyResult> {
	const email = normalizeEmail(rawEmail);
	const row = (
		await db
			.select()
			.from(loginTokens)
			.where(
				and(
					eq(loginTokens.email, email),
					eq(loginTokens.kind, 'code'),
					isNull(loginTokens.consumedAt)
				)
			)
			.orderBy(desc(loginTokens.createdAt))
			.limit(1)
	).at(0);

	if (!row) return { ok: false, reason: 'invalid' };
	if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

	if ((await hashToken(code)) !== row.tokenHash) {
		// Increment atomically so concurrent wrong guesses can't lose a count.
		const [{ attempts }] = await db
			.update(loginTokens)
			.set({ attempts: sql`${loginTokens.attempts} + 1` })
			.where(eq(loginTokens.id, row.id))
			.returning({ attempts: loginTokens.attempts });
		if (attempts >= CODE_MAX_ATTEMPTS) {
			await db
				.update(loginTokens)
				.set({ consumedAt: new Date() })
				.where(eq(loginTokens.id, row.id));
			return { ok: false, reason: 'too_many_attempts' };
		}
		return { ok: false, reason: 'invalid' };
	}

	return consumeAndMint(db, row.id, email);
}

/** Atomically consume a validated login row and mint a session for an enabled user. */
async function consumeAndMint(db: Db, id: string, email: string): Promise<VerifyResult> {
	const consumed = await db
		.update(loginTokens)
		.set({ consumedAt: new Date() })
		.where(and(eq(loginTokens.id, id), isNull(loginTokens.consumedAt)))
		.returning({ id: loginTokens.id });
	if (consumed.length === 0) return { ok: false, reason: 'invalid' };

	const user = (await db.select().from(users).where(eq(users.email, email)).limit(1)).at(0);
	if (!user || user.status !== 'enabled') return { ok: false, reason: 'not_allowed' };

	const { token, expiresAt } = await createSession(db, user.id);
	return { ok: true, user, token, expiresAt };
}

/**
 * Permanently delete a user and everything tied to them, atomically. D1 has no
 * interactive transactions, so we use `db.batch()` — the four deletes run as one
 * all-or-nothing unit. Child rows are removed explicitly (not via FK cascade) so
 * this holds regardless of whether the connection enforces foreign keys:
 * sessions + email-change tokens by user id, login tokens by email (no FK).
 */
export async function deleteAccount(db: Db, user: User): Promise<void> {
	await db.batch([
		db.delete(emailChangeTokens).where(eq(emailChangeTokens.userId, user.id)),
		db.delete(sessions).where(eq(sessions.userId, user.id)),
		db.delete(loginTokens).where(eq(loginTokens.email, user.email)),
		db.delete(users).where(eq(users.id, user.id))
	]);
}

async function isRateLimited(db: Db, email: string, ip?: string | null): Promise<boolean> {
	const since = new Date(Date.now() - RATE_WINDOW_MS);
	// Count the one `kind='code'` row every request writes, so a browser request
	// (which also writes a `kind='link'` row) still counts as a single request.
	const [{ n }] = await db
		.select({ n: count() })
		.from(loginTokens)
		.where(
			and(
				eq(loginTokens.email, email),
				eq(loginTokens.kind, 'code'),
				gte(loginTokens.createdAt, since)
			)
		);
	if (n >= RATE_MAX_PER_EMAIL) return true;

	if (ip) {
		const [{ n: byIp }] = await db
			.select({ n: count() })
			.from(loginTokens)
			.where(
				and(
					eq(loginTokens.requestIp, ip),
					eq(loginTokens.kind, 'code'),
					gte(loginTokens.createdAt, since)
				)
			);
		if (byIp >= RATE_MAX_PER_IP) return true;
	}
	return false;
}

export { normalizeEmail, EMAIL_REGEX, CODE_REGEX } from './validation';

export {
	validateSession,
	invalidateSession,
	deleteSessionCookie,
	setSessionCookie,
	SESSION_COOKIE
} from './session';

export {
	requestEmailChange,
	verifyEmailChange,
	EMAIL_CHANGE_TTL_MINUTES,
	type EmailChangeRequestResult,
	type EmailChangeVerifyResult
} from './email-change';
