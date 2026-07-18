import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, index } from 'drizzle-orm/sqlite-core';

/**
 * Account states for the gated (waitlist) auth flow:
 * - `pending`  — signed up, waiting for access; cannot receive a login link.
 * - `enabled`  — approved; can request links and sign in.
 * - `blocked`  — denied; cannot request links or hold a session.
 * New signups start `pending`; promotion to `enabled` is a manual DB flip
 * during the private beta.
 */
export const USER_STATUSES = ['pending', 'enabled', 'blocked'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * A registered user. Identity is the verified email address — there are no
 * passwords (auth is passwordless magic link). Users are created as `pending`
 * when they join the waitlist, not lazily at verify time.
 */
export const users = sqliteTable(
	'users',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		email: text('email').notNull().unique(),
		status: text('status', { enum: USER_STATUSES }).notNull().default('pending'),
		// Optional free-text reason recorded when an account is blocked (audit trail).
		blockedReason: text('blocked_reason'),
		// Requesting client IP at waitlist signup, for per-IP signup rate limiting.
		signupIp: text('signup_ip'),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date()),
		// Maintained by the `users_set_updated_at` DB trigger (see migration) so it
		// tracks *every* change, including manual status flips via raw SQL. Stored as
		// Unix seconds, matching Drizzle's `timestamp` mode.
		updatedAt: integer('updated_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(unixepoch())`)
	},
	(table) => [index('users_signup_ip_idx').on(table.signupIp)]
);

/**
 * A short-lived magic-link token. We store only the SHA-256 hash of the token;
 * the raw token travels solely in the emailed link, so a DB read cannot mint a
 * valid link. Links are only ever issued to `enabled` users.
 */
export const loginTokens = sqliteTable(
	'login_tokens',
	{
		// SHA-256 hex of the raw token — also the lookup key.
		tokenHash: text('token_hash').primaryKey(),
		email: text('email').notNull(),
		// Requesting client IP, for per-IP email-bomb rate limiting (nullable if unknown).
		requestIp: text('request_ip'),
		expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
		consumedAt: integer('consumed_at', { mode: 'timestamp' }),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date())
	},
	(table) => [
		index('login_tokens_email_idx').on(table.email),
		index('login_tokens_request_ip_idx').on(table.requestIp)
	]
);

/**
 * A server-side session. The cookie carries a random token; we store only its
 * SHA-256 hash (as the primary key), so a leaked DB cannot be used to forge a
 * session cookie. `lastUsedAt` is refreshed on each authenticated request.
 */
export const sessions = sqliteTable(
	'sessions',
	{
		// SHA-256 hex of the raw session token held in the cookie.
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date()),
		lastUsedAt: integer('last_used_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date())
	},
	(table) => [index('sessions_user_id_idx').on(table.userId)]
);

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type LoginToken = typeof loginTokens.$inferSelect;
