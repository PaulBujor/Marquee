import { and, count, desc, eq, gte, isNull } from 'drizzle-orm';
import type { createDb } from '$lib/server/db';
import { loginTokens, users, type User } from '$lib/server/db/schema';
import type { EmailSender } from '$lib/server/email';
import { createSession } from './session';
import { generateCode, generateToken, hashToken } from './tokens';

type Db = ReturnType<typeof createDb>;

/** Magic links (browser) live a little longer than typed codes (PWA). */
const LINK_TTL_MS = 15 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
/** Failed code entries before the code is invalidated (online brute-force cap). */
const CODE_MAX_ATTEMPTS = 5;
/** Email-bomb protection: cap link/code requests per email and per IP within a window. */
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_PER_EMAIL = 5;
const RATE_MAX_PER_IP = 20;
/** Per-IP cap on unauthenticated waitlist signups within RATE_WINDOW_MS. */
const SIGNUP_MAX_PER_IP = 10;

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/** Where the sign-in request came from: an installed PWA vs a browser tab. */
export type SignInMode = 'standalone' | 'browser';

/**
 * Outcome of the request phase. Status-gated, so it deliberately reveals account
 * state (enabled / blocked / waitlisted / unknown) — not enumeration-resistant,
 * by design. On success, `method` is what was emailed (a link for browsers, a
 * code for installed PWAs, which can't capture the link).
 */
export type RequestResult =
	| { kind: 'sent'; method: 'link' | 'code' }
	| { kind: 'blocked' }
	| { kind: 'waitlisted' }
	| { kind: 'unknown' }
	| { kind: 'rate_limited' };

/**
 * Request phase: branch on account status; for an enabled user, email a magic
 * link (browser) or a 6-digit code (PWA) per `mode`. Unknown addresses are
 * invited to join the waitlist (see `joinWaitlist`), not created here.
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
		const code = generateCode();
		await opts.db.insert(loginTokens).values({
			email,
			tokenHash: await hashToken(code),
			kind: 'code',
			requestIp: opts.ip ?? null,
			expiresAt: new Date(Date.now() + CODE_TTL_MS)
		});
		await opts.sender.send({
			to: email,
			subject: 'Your Marquee sign-in code',
			html: renderCodeEmail(code, CODE_TTL_MS / 60000)
		});
		return { kind: 'sent', method: 'code' };
	}

	const token = generateToken();
	await opts.db.insert(loginTokens).values({
		email,
		tokenHash: await hashToken(token),
		kind: 'link',
		requestIp: opts.ip ?? null,
		expiresAt: new Date(Date.now() + LINK_TTL_MS)
	});
	const url = `${opts.origin}/auth/verify?token=${encodeURIComponent(token)}`;
	await opts.sender.send({
		to: email,
		subject: 'Your Marquee sign-in link',
		html: renderMagicLinkEmail(url, LINK_TTL_MS / 60000)
	});
	return { kind: 'sent', method: 'link' };
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
		const attempts = row.attempts + 1;
		if (attempts >= CODE_MAX_ATTEMPTS) {
			await db
				.update(loginTokens)
				.set({ attempts, consumedAt: new Date() })
				.where(eq(loginTokens.id, row.id));
			return { ok: false, reason: 'too_many_attempts' };
		}
		await db.update(loginTokens).set({ attempts }).where(eq(loginTokens.id, row.id));
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

async function isRateLimited(db: Db, email: string, ip?: string | null): Promise<boolean> {
	const since = new Date(Date.now() - RATE_WINDOW_MS);
	const [{ n }] = await db
		.select({ n: count() })
		.from(loginTokens)
		.where(and(eq(loginTokens.email, email), gte(loginTokens.createdAt, since)));
	if (n >= RATE_MAX_PER_EMAIL) return true;

	if (ip) {
		const [{ n: byIp }] = await db
			.select({ n: count() })
			.from(loginTokens)
			.where(and(eq(loginTokens.requestIp, ip), gte(loginTokens.createdAt, since)));
		if (byIp >= RATE_MAX_PER_IP) return true;
	}
	return false;
}

function renderMagicLinkEmail(url: string, ttlMinutes: number): string {
	return `<!doctype html>
<html>
	<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #111;">
		<h2 style="margin: 0 0 16px; font-family: 'Fraunces', Georgia, 'Times New Roman', serif; font-weight: 600;">Sign in to Marquee</h2>
		<p>Click the button below to sign in. This link expires in ${ttlMinutes} minutes and can be used once.</p>
		<p style="margin: 24px 0;">
			<a href="${url}" style="background: #8b5cf6; color: #ffffff; padding: 12px 20px; border-radius: 8px; text-decoration: none; display: inline-block; font-weight: 600;">Sign in to Marquee</a>
		</p>
		<p style="color: #666; font-size: 13px;">If you didn't request this, you can safely ignore this email.</p>
		<p style="color: #666; font-size: 13px; word-break: break-all;">Or paste this link into your browser:<br />${url}</p>
	</body>
</html>`;
}

function renderCodeEmail(code: string, ttlMinutes: number): string {
	return `<!doctype html>
<html>
	<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #111;">
		<h2 style="margin: 0 0 16px; font-family: 'Fraunces', Georgia, 'Times New Roman', serif; font-weight: 600;">Your sign-in code</h2>
		<p>Enter this code in Marquee to sign in. It expires in ${ttlMinutes} minutes.</p>
		<p style="margin: 24px 0; font-size: 32px; font-weight: 700; letter-spacing: 8px; font-family: ui-monospace, 'SF Mono', Menlo, monospace;">${code}</p>
		<p style="color: #666; font-size: 13px;">If you didn't request this, you can safely ignore this email.</p>
	</body>
</html>`;
}

function renderWaitlistEmail(): string {
	return `<!doctype html>
<html>
	<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #111;">
		<h2 style="margin: 0 0 16px; font-family: 'Fraunces', Georgia, 'Times New Roman', serif; font-weight: 600;">You're on the waitlist</h2>
		<p>Thanks for your interest in Marquee — you're on the list. We'll email you as soon as your account is ready to sign in.</p>
		<p style="color: #666; font-size: 13px;">If you didn't sign up, you can safely ignore this email.</p>
	</body>
</html>`;
}

export {
	validateSession,
	invalidateSession,
	deleteSessionCookie,
	setSessionCookie,
	SESSION_COOKIE
} from './session';
