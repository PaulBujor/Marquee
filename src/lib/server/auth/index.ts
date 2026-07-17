import { and, count, eq, gte, isNull } from 'drizzle-orm';
import type { createDb } from '$lib/server/db';
import { loginTokens, users, type User } from '$lib/server/db/schema';
import type { EmailSender } from '$lib/server/email';
import { createSession } from './session';
import { generateToken, hashToken } from './tokens';

type Db = ReturnType<typeof createDb>;

/** Magic links expire quickly — long enough to switch to an email client. */
const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;
/** Throttle window and cap on link requests per email address. */
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_PER_WINDOW = 5;

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export type VerifyResult =
	| { ok: true; user: User; token: string; expiresAt: Date }
	| { ok: false; reason: 'invalid' | 'expired' };

/**
 * Issue a magic link for `email` and send it. Behaves identically whether or
 * not the address belongs to an existing user (the account is created on
 * verify), so this endpoint never reveals whether an email is registered.
 * Returns `false` when the per-address rate limit is hit.
 */
export async function requestMagicLink(opts: {
	db: Db;
	email: string;
	sender: EmailSender;
	origin: string;
}): Promise<boolean> {
	const email = normalizeEmail(opts.email);
	const now = Date.now();

	const [{ n }] = await opts.db
		.select({ n: count() })
		.from(loginTokens)
		.where(
			and(eq(loginTokens.email, email), gte(loginTokens.createdAt, new Date(now - RATE_WINDOW_MS)))
		);
	if (n >= RATE_MAX_PER_WINDOW) return false;

	const token = generateToken();
	const tokenHash = await hashToken(token);
	const expiresAt = new Date(now + LOGIN_TOKEN_TTL_MS);
	await opts.db.insert(loginTokens).values({ tokenHash, email, expiresAt });

	const url = `${opts.origin}/auth/verify?token=${encodeURIComponent(token)}`;
	await opts.sender.send({
		to: email,
		subject: 'Your Marquee sign-in link',
		html: renderMagicLinkEmail(url, LOGIN_TOKEN_TTL_MS / 60000)
	});
	return true;
}

/**
 * Validate and consume a magic-link token. On success creates (or reuses) the
 * user, mints a session, and returns the raw session token for the cookie.
 * Tokens are single-use — consumption is atomic against concurrent replays.
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

	const user = await findOrCreateUser(db, row.email);
	const { token, expiresAt } = await createSession(db, user.id);
	return { ok: true, user, token, expiresAt };
}

async function findOrCreateUser(db: Db, email: string): Promise<User> {
	const existing = (await db.select().from(users).where(eq(users.email, email)).limit(1)).at(0);
	if (existing) return existing;
	const [created] = await db.insert(users).values({ email }).returning();
	return created;
}

function renderMagicLinkEmail(url: string, ttlMinutes: number): string {
	return `<!doctype html>
<html>
	<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #111;">
		<h2 style="margin: 0 0 16px;">Sign in to Marquee</h2>
		<p>Click the button below to sign in. This link expires in ${ttlMinutes} minutes and can be used once.</p>
		<p style="margin: 24px 0;">
			<a href="${url}" style="background: #111; color: #fff; padding: 12px 20px; border-radius: 8px; text-decoration: none; display: inline-block;">Sign in to Marquee</a>
		</p>
		<p style="color: #666; font-size: 13px;">If you didn't request this, you can safely ignore this email.</p>
		<p style="color: #666; font-size: 13px; word-break: break-all;">Or paste this link into your browser:<br />${url}</p>
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
