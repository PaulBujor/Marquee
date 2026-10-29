import { and, count, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { createDb } from '#lib/server/db/index.js';
import {
	emailChangeTokens,
	episodeWatches,
	events,
	loginTokens,
	media,
	notificationLog,
	people,
	pushSubscriptions,
	sessions,
	sharePreviewWarms,
	syncState,
	tracking,
	users,
	type User
} from '#lib/server/db/schema.js';
import type { EmailSender } from '#lib/server/email/index.js';
import {
	renderCodeEmail,
	renderMagicLinkAndCodeEmail,
	renderWaitlistEmail
} from '#lib/server/email/templates.js';
import { createSession } from './session';
import { generateCode, generateToken, hashToken } from './tokens';
import { normalizeEmail } from './validation';
import { safeRedirectPath } from '#lib/redirect.js';

type Db = ReturnType<typeof createDb>;

/** A code is only ~20 bits vs the link's 256, so its TTL is shorter to limit online brute force. */
export const LINK_TTL_MINUTES = 15;
export const CODE_TTL_MINUTES = 10;
const LINK_TTL_MS = LINK_TTL_MINUTES * 60 * 1000;
const CODE_TTL_MS = CODE_TTL_MINUTES * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_PER_EMAIL = 5;
const RATE_MAX_PER_IP = 20;
const SIGNUP_MAX_PER_IP = 10;

export type SignInMode = 'standalone' | 'browser';

/** Deliberately reveals account state — not enumeration-resistant, by design. */
export type RequestResult =
	| { kind: 'sent'; method: 'code' | 'link_and_code' }
	| { kind: 'blocked' }
	| { kind: 'waitlisted' }
	| { kind: 'unknown' }
	| { kind: 'rate_limited' };

export async function requestSignIn(opts: {
	db: Db;
	email: string;
	sender: EmailSender;
	origin: string;
	mode: SignInMode;
	ip?: string | null;
	/** Where to land after sign-in — carried into the emailed link, re-validated on the way back. */
	redirectTo?: string | null;
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

	const { code, supersede, insert: codeInsert } = await codeWrites(opts.db, email, opts.ip);
	const { url, insert: linkInsert } = await linkWrite(
		opts.db,
		email,
		opts.origin,
		opts.ip,
		opts.redirectTo
	);
	await opts.db.batch([supersede, codeInsert, linkInsert]);
	await opts.sender.send({
		to: email,
		subject: 'Your Marquee sign-in link and code',
		html: renderMagicLinkAndCodeEmail(url, code, LINK_TTL_MINUTES, CODE_TTL_MINUTES)
	});
	return { kind: 'sent', method: 'link_and_code' };
}

/** Builds (doesn't run) the writes so callers can batch them into a single D1 round-trip. */
async function codeWrites(db: Db, email: string, ip?: string | null) {
	const code = generateCode();
	const tokenHash = await hashToken(code);
	// One live code per email: verify can't disambiguate two issued in the same second.
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

async function linkWrite(
	db: Db,
	email: string,
	origin: string,
	ip?: string | null,
	redirectTo?: string | null
) {
	const token = generateToken();
	const insert = db.insert(loginTokens).values({
		email,
		tokenHash: await hashToken(token),
		kind: 'link',
		requestIp: ip ?? null,
		expiresAt: new Date(Date.now() + LINK_TTL_MS)
	});
	// Only a same-origin path is ever put in the email, and `/auth/verify` re-validates it anyway.
	const path = safeRedirectPath(redirectTo, '');
	const carried = path === '' || path === '/' ? '' : `&redirectTo=${encodeURIComponent(path)}`;
	return { url: `${origin}/auth/verify?token=${encodeURIComponent(token)}${carried}`, insert };
}

export type JoinResult =
	{ kind: 'waitlisted' } | { kind: 'blocked' } | { kind: 'already' } | { kind: 'rate_limited' };

/** Promotion to `enabled` is a manual DB flip during the private beta. */
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
	// Best-effort: the signup already succeeded, so a send failure must not fail the request.
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
		// Atomic increment so concurrent wrong guesses can't lose a count; a missing row was purged.
		const incremented = await db
			.update(loginTokens)
			.set({ attempts: sql`${loginTokens.attempts} + 1` })
			.where(eq(loginTokens.id, row.id))
			.returning({ attempts: loginTokens.attempts });
		const attempts = incremented.at(0)?.attempts;
		if (attempts === undefined) return { ok: false, reason: 'invalid' };
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

/** Delete children before the `users` row: D1 doesn't enforce the cascade everywhere; shared catalog rows stay. */
export async function deleteAccount(db: Db, user: User): Promise<void> {
	await db.batch([
		db.delete(emailChangeTokens).where(eq(emailChangeTokens.userId, user.id)),
		db.delete(sessions).where(eq(sessions.userId, user.id)),
		db.delete(loginTokens).where(eq(loginTokens.email, user.email)),
		db.delete(events).where(eq(events.userId, user.id)),
		db.delete(syncState).where(eq(syncState.userId, user.id)),
		db.delete(tracking).where(eq(tracking.userId, user.id)),
		db.delete(episodeWatches).where(eq(episodeWatches.userId, user.id)),
		db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, user.id)),
		db.delete(notificationLog).where(eq(notificationLog.userId, user.id)),
		db.delete(sharePreviewWarms).where(eq(sharePreviewWarms.userId, user.id)),
		db.delete(media).where(eq(media.ownerUserId, user.id)),
		db.delete(people).where(eq(people.ownerUserId, user.id)),
		db.delete(users).where(eq(users.id, user.id))
	]);
}

async function isRateLimited(db: Db, email: string, ip?: string | null): Promise<boolean> {
	const since = new Date(Date.now() - RATE_WINDOW_MS);
	// Count the one `kind='code'` row every request writes, so a browser request counts once.
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
	invalidateOtherSessions,
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
