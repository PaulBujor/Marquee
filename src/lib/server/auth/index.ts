import { and, count, eq, gte, isNull } from 'drizzle-orm';
import type { createDb } from '$lib/server/db';
import { loginTokens, users, type User } from '$lib/server/db/schema';
import type { EmailSender } from '$lib/server/email';
import { createSession } from './session';
import { generateToken, hashToken } from './tokens';

type Db = ReturnType<typeof createDb>;

/** Magic links expire quickly — long enough to switch to an email client. */
const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;
/** Email-bomb protection: cap link requests per email and per IP within a window. */
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_PER_EMAIL = 5;
const RATE_MAX_PER_IP = 20;
/** Per-IP cap on unauthenticated waitlist signups within RATE_WINDOW_MS. */
const SIGNUP_MAX_PER_IP = 10;

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/**
 * Outcome of the request phase. Status-gated, so it deliberately reveals account
 * state (enabled / blocked / waitlisted / unknown) — not enumeration-resistant,
 * by design.
 */
export type RequestResult =
	| { kind: 'sent' }
	| { kind: 'blocked' }
	| { kind: 'waitlisted' }
	| { kind: 'unknown' }
	| { kind: 'rate_limited' };

/**
 * Request phase: look up the account by email and branch on its status. Only
 * `enabled` users are sent a magic link; `pending`/`blocked` are told their
 * state, and unknown addresses are invited to join the waitlist (see
 * `joinWaitlist`) rather than being created here.
 */
export async function requestMagicLink(opts: {
	db: Db;
	email: string;
	sender: EmailSender;
	origin: string;
	ip?: string | null;
}): Promise<RequestResult> {
	const email = normalizeEmail(opts.email);
	const user = (await opts.db.select().from(users).where(eq(users.email, email)).limit(1)).at(0);

	if (!user) return { kind: 'unknown' };
	if (user.status === 'blocked') return { kind: 'blocked' };
	if (user.status === 'pending') return { kind: 'waitlisted' };

	// user.status === 'enabled'
	if (await isRateLimited(opts.db, email, opts.ip)) return { kind: 'rate_limited' };

	const token = generateToken();
	const tokenHash = await hashToken(token);
	const expiresAt = new Date(Date.now() + LOGIN_TOKEN_TTL_MS);
	await opts.db
		.insert(loginTokens)
		.values({ tokenHash, email, requestIp: opts.ip ?? null, expiresAt });

	const url = `${opts.origin}/auth/verify?token=${encodeURIComponent(token)}`;
	await opts.sender.send({
		to: email,
		subject: 'Your Marquee sign-in link',
		html: renderMagicLinkEmail(url, LOGIN_TOKEN_TTL_MS / 60000)
	});
	return { kind: 'sent' };
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
	| { ok: false; reason: 'invalid' | 'expired' | 'not_allowed' };

/**
 * Verify phase: validate and consume a magic-link token, then mint a session —
 * but only for an `enabled` user. Tokens are single-use (consumption is atomic
 * against concurrent replays). No user is created here; that happens at
 * waitlist signup, and links are only ever issued to enabled accounts.
 */
export async function verifyMagicLink(db: Db, rawToken: string): Promise<VerifyResult> {
	const tokenHash = await hashToken(rawToken);
	const row = (
		await db.select().from(loginTokens).where(eq(loginTokens.tokenHash, tokenHash)).limit(1)
	).at(0);

	if (!row || row.consumedAt) return { ok: false, reason: 'invalid' };
	if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

	// Atomically claim the token; if another request beat us to it, bail.
	const consumed = await db
		.update(loginTokens)
		.set({ consumedAt: new Date() })
		.where(and(eq(loginTokens.tokenHash, tokenHash), isNull(loginTokens.consumedAt)))
		.returning({ tokenHash: loginTokens.tokenHash });
	if (consumed.length === 0) return { ok: false, reason: 'invalid' };

	const user = (await db.select().from(users).where(eq(users.email, row.email)).limit(1)).at(0);
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

/**
 * Shared shell for transactional emails. Links the Fraunces webfont (email
 * clients strip CSS vars, so it can't reference `--font-serif`) and renders the
 * heading with the app's serif stack + weight; clients without webfont support
 * fall back to serif. Colours are inlined literally — keep them in sync with the
 * design tokens in `src/routes/layout.css`.
 */
function renderEmail(heading: string, body: string): string {
	return `<!doctype html>
<html>
	<head>
		<meta charset="utf-8" />
		<link rel="preconnect" href="https://fonts.googleapis.com" />
		<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
		<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&display=swap" rel="stylesheet" />
	</head>
	<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #111;">
		<h2 style="margin: 0 0 16px; font-family: 'Fraunces', ui-serif, Georgia, serif; font-weight: 600;">${heading}</h2>
		${body}
	</body>
</html>`;
}

function renderMagicLinkEmail(url: string, ttlMinutes: number): string {
	return renderEmail(
		'Sign in to Marquee',
		`<p>Click the button below to sign in. This link expires in ${ttlMinutes} minutes and can be used once.</p>
		<p style="margin: 24px 0;">
			<a href="${url}" style="background: #8b5cf6; color: #ffffff; padding: 12px 20px; border-radius: 10px; text-decoration: none; display: inline-block; font-size: 14px; font-weight: 500;">Sign in to Marquee</a>
		</p>
		<p style="color: #666; font-size: 13px;">If you didn't request this, you can safely ignore this email.</p>
		<p style="color: #666; font-size: 13px; word-break: break-all;">Or paste this link into your browser:<br />${url}</p>`
	);
}

function renderWaitlistEmail(): string {
	return renderEmail(
		"You're on the waitlist",
		`<p>Thanks for your interest in Marquee — you're on the list. We'll email you as soon as your account is ready to sign in.</p>
		<p style="color: #666; font-size: 13px;">If you didn't sign up, you can safely ignore this email.</p>`
	);
}

export {
	validateSession,
	invalidateSession,
	deleteSessionCookie,
	setSessionCookie,
	SESSION_COOKIE
} from './session';
