import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
// Relative (not `$lib`) so drizzle-kit's esbuild bundler resolves it outside Vite.
import { SYNC_EVENT_TYPES, TRACKING_STATUSES } from '../../sync/events';

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
 * Delivery method for a sign-in secret: a `link` (long token in an emailed URL,
 * for browser tabs) or a `code` (6-digit OTP the user types, for installed PWAs
 * that can't capture the link). Chosen per request from the client display mode.
 */
export const LOGIN_KINDS = ['link', 'code'] as const;
export type LoginKind = (typeof LOGIN_KINDS)[number];

/**
 * A short-lived sign-in secret. We store only the SHA-256 hash — the raw
 * link-token/code travels only in the email — so a DB read can't reconstruct it.
 * Issued only to `enabled` users. Codes are looked up by email (a 6-digit code
 * isn't unique across users, so the hash can't be the primary key); `attempts`
 * caps online brute-forcing of a code before it's invalidated.
 */
export const loginTokens = sqliteTable(
	'login_tokens',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		email: text('email').notNull(),
		// SHA-256 hex of the raw link-token or code.
		tokenHash: text('token_hash').notNull(),
		kind: text('kind', { enum: LOGIN_KINDS }).notNull(),
		// Requesting client IP, for per-IP email-bomb rate limiting (nullable if unknown).
		requestIp: text('request_ip'),
		// Failed code-verification attempts; the code is invalidated past a cap.
		attempts: integer('attempts').notNull().default(0),
		expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
		consumedAt: integer('consumed_at', { mode: 'timestamp' }),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date())
	},
	(table) => [
		index('login_tokens_email_idx').on(table.email),
		index('login_tokens_token_hash_idx').on(table.tokenHash),
		index('login_tokens_request_ip_idx').on(table.requestIp)
	]
);

/** Confirms an account-email change: a hashed 6-digit code scoped to a user + target address. */
export const emailChangeTokens = sqliteTable(
	'email_change_tokens',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		// The address the code was sent to and that we'll switch the account to.
		newEmail: text('new_email').notNull(),
		// SHA-256 hex of the raw 6-digit code.
		tokenHash: text('token_hash').notNull(),
		// Failed verification attempts; the token is invalidated past a cap.
		attempts: integer('attempts').notNull().default(0),
		expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
		consumedAt: integer('consumed_at', { mode: 'timestamp' }),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date())
	},
	(table) => [index('email_change_tokens_user_id_idx').on(table.userId)]
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
export type EmailChangeToken = typeof emailChangeTokens.$inferSelect;

/* ------------------------------------------------------------------ *
 * Offline & Sync — event-sourced tracking model.
 *
 * The append-only `events` log is the source of truth for *what the user did*;
 * `tracking` and `episode_watches` are materialized *projections* of it (see
 * `src/lib/server/sync/projection.ts`). `media` is separate **reference data** —
 * a catalog cache seeded from the sync request, not derived from the log. Unlike
 * `users`, these tables have no `updated_at` trigger: every write flows through
 * projection code, which sets the LWW clocks explicitly — no raw-SQL edits to catch.
 * ------------------------------------------------------------------ */

/**
 * Append-only event log. The primary key is the **client-supplied** UUID (so it
 * has no `$defaultFn`), which is also the global dedup key — replaying a synced
 * event is a no-op. `sequence` is a per-user monotonic counter assigned by the server
 * (see `syncState`); the client sync cursor is the highest `sequence` it has pulled.
 */
export const events = sqliteTable(
	'events',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		sequence: integer('sequence').notNull(),
		type: text('type', { enum: SYNC_EVENT_TYPES }).notNull(),
		// The aggregate the event targets — the deterministic `mediaId` (`type:tmdbId`).
		entityId: text('entity_id').notNull(),
		// JSON.stringify of the event payload (shape depends on `type`).
		payload: text('payload').notNull(),
		deviceId: text('device_id').notNull(),
		schemaVersion: integer('schema_version').notNull().default(1),
		// Epoch **ms** on the originating device — the LWW ordering clock. Plain integer
		// (not `timestamp` mode, which is Unix seconds) to preserve millisecond precision.
		clientCreatedAt: integer('client_created_at').notNull(),
		// Audit-only wall-clock; `timestamp` mode stores Unix seconds, so it's coarser
		// than the ms `clientCreatedAt`. Not used for ordering or LWW (that's `seq` /
		// `clientCreatedAt`), so the reduced precision is fine.
		serverReceivedAt: integer('server_received_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date())
	},
	(table) => [uniqueIndex('events_user_sequence_idx').on(table.userId, table.sequence)]
);

/**
 * Per-user sequence allocator. A single upsert-with-RETURNING against this row
 * atomically reserves a disjoint block of `sequence` values, so concurrent sync
 * requests (separate Worker invocations) never collide on `events_user_sequence_idx`.
 */
export const syncState = sqliteTable('sync_state', {
	userId: text('user_id')
		.primaryKey()
		.references(() => users.id, { onDelete: 'cascade' }),
	lastSequence: integer('last_sequence').notNull().default(0)
});

/**
 * Global media catalog cache (not user-scoped) — **reference data, not a projection of
 * the event log**. Populated from the `media` sidecar of the sync request (see
 * `SyncRequest`), keyed by our media id, which events reference via `entityId`. Mirrors
 * `MediaSearchResult`; TMDB remains the real source, this is a display cache so tracked
 * titles render offline.
 */
export const media = sqliteTable(
	'media',
	{
		// Deterministic `mediaId` — `${type}:${tmdbId}`.
		id: text('id').primaryKey(),
		tmdbId: integer('tmdb_id').notNull(),
		type: text('type', { enum: ['movie', 'show'] }).notNull(),
		title: text('title').notNull(),
		year: integer('year'),
		posterPath: text('poster_path'),
		overview: text('overview').notNull().default(''),
		// Epoch **ms** (plain integer, not `timestamp`/seconds) — it's an LWW clock
		// compared against event `clientCreatedAt`, so units must match.
		updatedAt: integer('updated_at')
			.notNull()
			.$defaultFn(() => Date.now())
	},
	(table) => [uniqueIndex('media_tmdb_idx').on(table.tmdbId, table.type)]
);

/**
 * A user's tracking row for a title. `mediaId` intentionally has **no FK** to
 * `media`: a `tracking.status_changed` can arrive from another device before this
 * server has seen the corresponding `tracking.added`, so decoupling avoids FK
 * failures and keeps event ordering robust. Per-field LWW clocks (epoch ms of the
 * winning event's `clientCreatedAt`) let independent fields merge without clobber.
 * `removed` is a tombstone so a delete can lose to a later re-add deterministically.
 */
export const tracking = sqliteTable(
	'tracking',
	{
		// Deterministic PK — `${userId}::${mediaId}`.
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		mediaId: text('media_id').notNull(),
		status: text('status', { enum: TRACKING_STATUSES }).notNull().default('want_to_watch'),
		favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
		removed: integer('removed', { mode: 'boolean' }).notNull().default(false),
		statusUpdatedAt: integer('status_updated_at').notNull().default(0),
		favoriteUpdatedAt: integer('favorite_updated_at').notNull().default(0),
		removedUpdatedAt: integer('removed_updated_at').notNull().default(0),
		addedAt: integer('added_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer('updated_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date())
	},
	(table) => [index('tracking_user_status_idx').on(table.userId, table.status)]
);

/**
 * Per-episode watched state for a user + show. Progress rings are *derived* from
 * these rows, never stored. `updatedAt` is the epoch-ms LWW clock.
 */
export const episodeWatches = sqliteTable(
	'episode_watches',
	{
		// Deterministic PK — `${userId}::${mediaId}::s{S}e{E}`.
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		mediaId: text('media_id').notNull(),
		season: integer('season').notNull(),
		episode: integer('episode').notNull(),
		watched: integer('watched', { mode: 'boolean' }).notNull().default(false),
		updatedAt: integer('updated_at').notNull().default(0)
	},
	(table) => [index('episode_watches_user_media_idx').on(table.userId, table.mediaId)]
);

export type Event = typeof events.$inferSelect;
export type SyncState = typeof syncState.$inferSelect;
export type Media = typeof media.$inferSelect;
export type Tracking = typeof tracking.$inferSelect;
export type EpisodeWatch = typeof episodeWatches.$inferSelect;
