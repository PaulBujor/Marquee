import { integer, sqliteTable, text, index } from 'drizzle-orm/sqlite-core';

/**
 * A registered user. Identity is the verified email address — there are no
 * passwords (auth is passwordless magic link). Users are created lazily on the
 * first successful link verification, so no signup step is needed.
 */
export const users = sqliteTable('users', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	email: text('email').notNull().unique(),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

/**
 * A short-lived magic-link token. We store only the SHA-256 hash of the token;
 * the raw token travels solely in the emailed link, so a DB read cannot mint a
 * valid link. `email` is captured at request time (the user may not exist yet).
 */
export const loginTokens = sqliteTable(
	'login_tokens',
	{
		// SHA-256 hex of the raw token — also the lookup key.
		tokenHash: text('token_hash').primaryKey(),
		email: text('email').notNull(),
		expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
		consumedAt: integer('consumed_at', { mode: 'timestamp' }),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date())
	},
	(table) => [index('login_tokens_email_idx').on(table.email)]
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
