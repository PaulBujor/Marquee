import { and, count, desc, eq, gte, isNull, sql, type SQL } from 'drizzle-orm';
import type { createDb } from '$lib/server/db';
import { emailChangeTokens, users, type User } from '$lib/server/db/schema';
import type { EmailSender } from '$lib/server/email';
import { renderEmailChangeCode } from '$lib/server/email/templates';
import { EMAIL_REGEX, normalizeEmail } from './validation';
import { generateCode, hashToken } from './tokens';
import { invalidateOtherSessions } from './session';
import { EMAIL_CHANGE_TTL_MINUTES } from '$lib/email-change';

type Db = ReturnType<typeof createDb>;

// Re-exported so `$lib/server/auth` keeps exposing it; the value lives in the client-safe module.
export { EMAIL_CHANGE_TTL_MINUTES };
const EMAIL_CHANGE_TTL_MS = EMAIL_CHANGE_TTL_MINUTES * 60 * 1000;
/** Failed code entries before the change token is invalidated (online brute-force cap). */
const MAX_ATTEMPTS = 5;
/**
 * Rate-limit change requests within an hour to limit email-bombing a third party (a code is emailed
 * to the *target* before it's confirmed). Three angles, mirroring `isRateLimited` in `./index`:
 * per requesting user, per **target address** (so multiple accounts can't hammer one inbox), and
 * per requesting IP.
 */
const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTS_PER_USER = 5;
const MAX_REQUESTS_PER_EMAIL = 5;
const MAX_REQUESTS_PER_IP = 20;

export type EmailChangeRequestResult =
	| { kind: 'sent' }
	| { kind: 'invalid' }
	| { kind: 'unchanged' }
	| { kind: 'taken' }
	| { kind: 'rate_limited' };

export type EmailChangeVerifyResult =
	| { ok: true; newEmail: string; previousEmail: string }
	| { ok: false; reason: 'invalid' | 'expired' | 'too_many_attempts' | 'taken' };

/**
 * Start a verified email change: validate the target address, then email a
 * 6-digit code to *that* address (proving the user controls it). Supersedes any
 * live change code for this user so verify never has to disambiguate. The switch
 * itself happens in `verifyEmailChange` once the code is confirmed.
 */
export async function requestEmailChange(opts: {
	db: Db;
	user: User;
	newEmail: string;
	sender: EmailSender;
	ip?: string | null;
}): Promise<EmailChangeRequestResult> {
	const newEmail = normalizeEmail(opts.newEmail);
	if (!EMAIL_REGEX.test(newEmail)) return { kind: 'invalid' };
	if (newEmail === opts.user.email) return { kind: 'unchanged' };

	const taken = (
		await opts.db.select({ id: users.id }).from(users).where(eq(users.email, newEmail)).limit(1)
	).at(0);
	if (taken) return { kind: 'taken' };

	// Rate-limit before issuing: count recent requests per user, per target address, and per IP.
	const since = new Date(Date.now() - RATE_WINDOW_MS);
	const countSince = async (where: SQL): Promise<number> => {
		const [{ n }] = await opts.db
			.select({ n: count() })
			.from(emailChangeTokens)
			.where(and(where, gte(emailChangeTokens.createdAt, since)));
		return n;
	};

	if ((await countSince(eq(emailChangeTokens.userId, opts.user.id))) >= MAX_REQUESTS_PER_USER)
		return { kind: 'rate_limited' };
	if ((await countSince(eq(emailChangeTokens.newEmail, newEmail))) >= MAX_REQUESTS_PER_EMAIL)
		return { kind: 'rate_limited' };
	if (
		opts.ip &&
		(await countSince(eq(emailChangeTokens.requestIp, opts.ip))) >= MAX_REQUESTS_PER_IP
	)
		return { kind: 'rate_limited' };

	// Keep at most one live code per user.
	await opts.db
		.update(emailChangeTokens)
		.set({ consumedAt: new Date() })
		.where(and(eq(emailChangeTokens.userId, opts.user.id), isNull(emailChangeTokens.consumedAt)));

	const code = generateCode();
	await opts.db.insert(emailChangeTokens).values({
		userId: opts.user.id,
		newEmail,
		tokenHash: await hashToken(code),
		requestIp: opts.ip ?? null,
		expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MS)
	});
	await opts.sender.send({
		to: newEmail,
		subject: 'Confirm your new Marquee email',
		html: renderEmailChangeCode(code, EMAIL_CHANGE_TTL_MINUTES)
	});
	return { kind: 'sent' };
}

/**
 * Complete a verified email change: match the latest live code for the user and,
 * on success, switch `users.email` to the target address. Single-use; failed
 * attempts are counted and the code is invalidated past the cap.
 */
export async function verifyEmailChange(opts: {
	db: Db;
	user: User;
	code: string;
	/** Raw session cookie of the device making the change, so it stays signed in. */
	keepSessionToken?: string | null;
}): Promise<EmailChangeVerifyResult> {
	const row = (
		await opts.db
			.select()
			.from(emailChangeTokens)
			.where(and(eq(emailChangeTokens.userId, opts.user.id), isNull(emailChangeTokens.consumedAt)))
			.orderBy(desc(emailChangeTokens.createdAt))
			.limit(1)
	).at(0);

	if (!row) return { ok: false, reason: 'invalid' };
	if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

	if ((await hashToken(opts.code)) !== row.tokenHash) {
		// Increment atomically so concurrent wrong guesses can't lose a count.
		const [{ attempts }] = await opts.db
			.update(emailChangeTokens)
			.set({ attempts: sql`${emailChangeTokens.attempts} + 1` })
			.where(eq(emailChangeTokens.id, row.id))
			.returning({ attempts: emailChangeTokens.attempts });
		if (attempts >= MAX_ATTEMPTS) {
			await opts.db
				.update(emailChangeTokens)
				.set({ consumedAt: new Date() })
				.where(eq(emailChangeTokens.id, row.id));
			return { ok: false, reason: 'too_many_attempts' };
		}
		return { ok: false, reason: 'invalid' };
	}

	// Consume atomically first; a lost race means it was already used.
	const consumed = await opts.db
		.update(emailChangeTokens)
		.set({ consumedAt: new Date() })
		.where(and(eq(emailChangeTokens.id, row.id), isNull(emailChangeTokens.consumedAt)))
		.returning({ id: emailChangeTokens.id });
	if (consumed.length === 0) return { ok: false, reason: 'invalid' };

	// Re-check uniqueness right before switching — the address may have been
	// claimed since the request (users.email is unique).
	const taken = (
		await opts.db.select({ id: users.id }).from(users).where(eq(users.email, row.newEmail)).limit(1)
	).at(0);
	if (taken) return { ok: false, reason: 'taken' };

	const previousEmail = opts.user.email;
	await opts.db.update(users).set({ email: row.newEmail }).where(eq(users.id, opts.user.id));

	// Sign-in is passwordless and keyed on the address, so moving it is a credential change: drop
	// every other session. Best-effort — the address has already changed, and failing the request
	// here would tell the user it didn't.
	try {
		await invalidateOtherSessions(opts.db, opts.user.id, opts.keepSessionToken ?? null);
	} catch (err) {
		console.error('email change: failed to invalidate other sessions', err);
	}

	return { ok: true, newEmail: row.newEmail, previousEmail };
}
