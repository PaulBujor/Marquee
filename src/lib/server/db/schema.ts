import { sql } from 'drizzle-orm';
import {
	integer,
	real,
	sqliteTable,
	text,
	index,
	primaryKey,
	uniqueIndex
} from 'drizzle-orm/sqlite-core';
// Relative (not `#lib`) so drizzle-kit's esbuild bundler resolves it outside Vite.
import {
	MEDIA_PROVIDERS,
	CREDIT_ROLES,
	MEDIA_SOURCES,
	SYNC_EVENT_TYPES,
	TRACKING_STATUSES,
	type EventPayload
} from '../../sync/events';

/** `pending` users can't log in; promotion to `enabled` is a manual SQL flip during the beta. */
export const USER_STATUSES = ['pending', 'enabled', 'blocked'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Who may reach the admin surface. `admin` is granted by SQL, never by signup. */
export const USER_ROLES = ['user', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Created at waitlist signup as `pending`, not lazily at verify time. */
export const users = sqliteTable(
	'users',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		email: text('email').notNull().unique(),
		status: text('status', { enum: USER_STATUSES }).notNull().default('pending'),
		role: text('role', { enum: USER_ROLES }).notNull().default('user'),
		blockedReason: text('blocked_reason'),
		deletedAt: integer('deleted_at', { mode: 'timestamp' }),
		signupIp: text('signup_ip'),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date()),
		// Maintained by a DB trigger so it tracks every change incl. raw SQL; Unix seconds, like Drizzle's `timestamp` mode.
		updatedAt: integer('updated_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(unixepoch())`)
	},
	(table) => [index('users_signup_ip_idx').on(table.signupIp)]
);

/** Installed PWAs can't capture an emailed link, so they get a 6-digit `code` instead. */
export const LOGIN_KINDS = ['link', 'code'] as const;
export type LoginKind = (typeof LOGIN_KINDS)[number];

/** Codes are looked up by email since a 6-digit code isn't unique; `attempts` caps online brute force. */
export const loginTokens = sqliteTable(
	'login_tokens',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		email: text('email').notNull(),
		tokenHash: text('token_hash').notNull(),
		kind: text('kind', { enum: LOGIN_KINDS }).notNull(),
		requestIp: text('request_ip'),
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
		index('login_tokens_request_ip_idx').on(table.requestIp),
		// Two indexed deletes rather than one OR across columns: an OR isn't planned as a single index scan.
		index('login_tokens_expires_at_idx').on(table.expiresAt),
		index('login_tokens_consumed_at_idx').on(table.consumedAt)
	]
);

export const emailChangeTokens = sqliteTable(
	'email_change_tokens',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		newEmail: text('new_email').notNull(),
		tokenHash: text('token_hash').notNull(),
		requestIp: text('request_ip'),
		attempts: integer('attempts').notNull().default(0),
		expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
		consumedAt: integer('consumed_at', { mode: 'timestamp' }),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date())
	},
	(table) => [
		index('email_change_tokens_user_id_idx').on(table.userId),
		index('email_change_tokens_new_email_idx').on(table.newEmail),
		index('email_change_tokens_request_ip_idx').on(table.requestIp)
	]
);

/** Only the token's SHA-256 hash is stored, as the PK, so a leaked DB can't forge a cookie. */
export const sessions = sqliteTable(
	'sessions',
	{
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
	(table) => [
		index('sessions_user_id_idx').on(table.userId),
		// The nightly purge deletes by expiry; unindexed it's a full scan of the table.
		index('sessions_expires_at_idx').on(table.expiresAt)
	]
);

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type LoginToken = typeof loginTokens.$inferSelect;
export type EmailChangeToken = typeof emailChangeTokens.$inferSelect;

// Unlike `users`, these tables have no `updated_at` trigger: every write flows through projection code, which sets the LWW clocks explicitly.

/** `id` is client-minted and untrusted, so the PK is `(user_id, id)` — a forged UUID can't collide with another user's event. */
export const events = sqliteTable(
	'events',
	{
		id: text('id').notNull(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		sequence: integer('sequence').notNull(),
		type: text('type', { enum: SYNC_EVENT_TYPES }).notNull(),
		// The aggregate the event targets — our own media id (see `mediaId()`).
		entityId: text('entity_id').notNull(),
		// SQLite has no JSON type, so it's stored as text; Drizzle (de)serializes it per `type`.
		payload: text('payload', { mode: 'json' }).$type<EventPayload>().notNull(),
		deviceId: text('device_id').notNull(),
		schemaVersion: integer('schema_version').notNull().default(1),
		// Epoch **ms** — the LWW ordering clock; `timestamp` mode would be seconds and lose precision.
		clientCreatedAt: integer('client_created_at').notNull(),
		// Audit-only wall-clock, coarser (Unix seconds) than `clientCreatedAt`; not used for ordering.
		serverReceivedAt: integer('server_received_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date())
	},
	(table) => [
		primaryKey({ columns: [table.userId, table.id] }),
		uniqueIndex('events_user_sequence_idx').on(table.userId, table.sequence)
	]
);

/** One upsert-with-RETURNING reserves a disjoint block, so concurrent Workers never collide on `events_user_sequence_idx`. */
export const syncState = sqliteTable('sync_state', {
	userId: text('user_id')
		.primaryKey()
		.references(() => users.id, { onDelete: 'cascade' }),
	lastSequence: integer('last_sequence').notNull().default(0)
});

/** Global (not user-scoped) catalog cache; `source` marks provider-backed `linked` vs user-authored `custom`. */
export const media = sqliteTable(
	'media',
	{
		id: text('id').primaryKey(),
		provider: text('provider', { enum: MEDIA_PROVIDERS }).notNull().default('tmdb'),
		// e.g. `movie/603`; null for custom entries.
		externalId: text('external_id'),
		source: text('source', { enum: MEDIA_SOURCES }).notNull().default('linked'),
		ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
		type: text('type', { enum: ['movie', 'show'] }).notNull(),
		title: text('title').notNull(),
		// Case-folded for offline search: JS `toLowerCase()` is full Unicode, SQLite `LIKE` is ASCII-only.
		titleNormalized: text('title_normalized').notNull().default(''),
		year: integer('year'),
		posterPath: text('poster_path'),
		backdropPath: text('backdrop_path'),
		overview: text('overview').notNull().default(''),
		genres: text('genres', { mode: 'json' }).$type<string[]>(),
		// `YYYY-MM-DD`. Movies only.
		releaseDate: text('release_date'),
		// TMDB status/production flags + air dates (`YYYY-MM-DD`). Shows only.
		status: text('status'),
		inProduction: integer('in_production', { mode: 'boolean' }),
		firstAirDate: text('first_air_date'),
		lastAirDate: text('last_air_date'),
		version: integer('version').notNull().default(1),
		// Epoch ms of the last TMDB pull (drives the refresh TTL); default 0 makes existing rows stale.
		refreshedAt: integer('refreshed_at').notNull().default(0),
		// Epoch ms, not seconds: an LWW clock compared against event `clientCreatedAt`, so units must match.
		updatedAt: integer('updated_at')
			.notNull()
			.$defaultFn(() => Date.now())
	},
	// SQLite treats each NULL as distinct in a UNIQUE index, so custom rows (`external_id = null`) never collide.
	(table) => [
		uniqueIndex('media_provider_external_idx').on(table.provider, table.externalId),
		// The nightly sweep's branches are separate queries rather than one OR'd query, so each gets its own index.
		index('media_type_in_production_idx').on(table.type, table.inProduction),
		index('media_type_release_date_idx').on(table.type, table.releaseDate),
		// A between-seasons show has `in_production` false but an airing status, so that branch needs its own index.
		index('media_type_status_idx').on(table.type, table.status),
		index('media_owner_idx').on(table.ownerUserId)
	]
);

/** A show's season. TMDB numbers Specials as season 0. */
export const seasons = sqliteTable(
	'seasons',
	{
		mediaId: text('media_id')
			.notNull()
			.references(() => media.id, { onDelete: 'cascade' }),
		seasonNumber: integer('season_number').notNull(),
		name: text('name').notNull().default(''),
		overview: text('overview').notNull().default(''),
		// `YYYY-MM-DD`, or null.
		airDate: text('air_date'),
		posterPath: text('poster_path'),
		episodeCount: integer('episode_count').notNull().default(0)
	},
	(table) => [primaryKey({ columns: [table.mediaId, table.seasonNumber] })]
);

/** A null `air_date` means it hasn't aired yet. */
export const episodes = sqliteTable(
	'episodes',
	{
		mediaId: text('media_id')
			.notNull()
			.references(() => media.id, { onDelete: 'cascade' }),
		seasonNumber: integer('season_number').notNull(),
		episodeNumber: integer('episode_number').notNull(),
		name: text('name').notNull().default(''),
		overview: text('overview').notNull().default(''),
		// `YYYY-MM-DD`, or null.
		airDate: text('air_date'),
		runtime: integer('runtime'),
		stillPath: text('still_path')
	},
	(table) => [
		primaryKey({ columns: [table.mediaId, table.seasonNumber, table.episodeNumber] }),
		index('episodes_air_date_idx').on(table.airDate),
		// The notify digest joins on media_id and range-filters air_date in one query, so this covers both.
		index('episodes_media_air_date_idx').on(table.mediaId, table.airDate)
	]
);

/** Provider-backed persons have a derived id; user-authored ones are scoped by `ownerUserId`, same as `media`. */
export const people = sqliteTable(
	'people',
	{
		id: text('id').primaryKey(),
		provider: text('provider', { enum: MEDIA_PROVIDERS }).notNull().default('tmdb'),
		// e.g. `person/287`; null for a user-authored person.
		externalId: text('external_id'),
		ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		profilePath: text('profile_path')
	},
	/** Each user keeps their own copy of a person, so owned rows can't share the catalogue's `(provider, external_id)` index. */
	(table) => [
		uniqueIndex('people_provider_external_idx')
			.on(table.provider, table.externalId)
			.where(sql`owner_user_id is null`),
		uniqueIndex('people_owner_external_idx')
			.on(table.ownerUserId, table.provider, table.externalId)
			.where(sql`owner_user_id is not null`),
		index('people_owner_idx').on(table.ownerUserId)
	]
);

export const credits = sqliteTable(
	'credits',
	{
		mediaId: text('media_id')
			.notNull()
			.references(() => media.id, { onDelete: 'cascade' }),
		personId: text('person_id')
			.notNull()
			.references(() => people.id, { onDelete: 'cascade' }),
		role: text('role', { enum: CREDIT_ROLES }).notNull(),
		// Who they played; cast only.
		character: text('character'),
		sortOrder: integer('sort_order').notNull().default(0)
	},
	(table) => [
		primaryKey({ columns: [table.mediaId, table.personId, table.role] }),
		index('credits_person_idx').on(table.personId)
	]
);

/** `media_id` has no FK on purpose: a `status_changed` from another device can arrive before `tracking.added`. */
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
		// Optional user rating 1–5; null = unrated.
		rating: integer('rating'),
		removed: integer('removed', { mode: 'boolean' }).notNull().default(false),
		statusUpdatedAt: integer('status_updated_at').notNull().default(0),
		favoriteUpdatedAt: integer('favorite_updated_at').notNull().default(0),
		ratingUpdatedAt: integer('rating_updated_at').notNull().default(0),
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

/** Progress rings are derived from these rows, never stored; `updatedAt` is the epoch-ms LWW clock. */
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
export type SeasonRow = typeof seasons.$inferSelect;
export type Person = typeof people.$inferSelect;
export type CreditRow = typeof credits.$inferSelect;
export type EpisodeRow = typeof episodes.$inferSelect;
export type Tracking = typeof tracking.$inferSelect;
export type EpisodeWatch = typeof episodeWatches.$inferSelect;

/** `timezone` (IANA) makes the digest fire at 9AM *local*; rows are deleted when the push service reports 404/410. */
export const pushSubscriptions = sqliteTable(
	'push_subscriptions',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		endpoint: text('endpoint').notNull().unique(),
		// Client public key (base64url, 65-byte P-256 point) and auth secret (base64url, 16 bytes).
		p256dh: text('p256dh').notNull(),
		auth: text('auth').notNull(),
		// The device that created the subscription (minted client-side, see idb `meta`).
		deviceId: text('device_id').notNull(),
		deviceLabel: text('device_label'),
		// IANA timezone (e.g. `Europe/Madrid`), auto-detected client-side; null → treated as UTC.
		timezone: text('timezone'),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date()),
		lastUsedAt: integer('last_used_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date())
	},
	(table) => [index('push_subscriptions_user_id_idx').on(table.userId)]
);

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

/** Deterministic id makes the digest exactly-once per release across retries, forced runs and missed days. */
export const notificationLog = sqliteTable(
	'notification_log',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		sentAt: integer('sent_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date())
	},
	(table) => [index('notification_log_user_id_idx').on(table.userId)]
);

export type NotificationLogRow = typeof notificationLog.$inferSelect;

/** Snapshot for public share pages, so the unauthenticated read path never calls TMDB and can't spend provider quota. */
export const sharePreviews = sqliteTable(
	'share_previews',
	{
		// `tmdb:<type>:<externalId>`; the type is in the key because TMDB ids are per-type, e.g. `movie/1399` ≠ `show/1399`.
		id: text('id').primaryKey(),
		provider: text('provider', { enum: MEDIA_PROVIDERS }).notNull().default('tmdb'),
		externalId: text('external_id').notNull(),
		titleType: text('title_type', { enum: ['movie', 'show'] }).notNull(),
		name: text('name').notNull(),
		year: integer('year'),
		summary: text('summary'),
		imagePath: text('image_path'),
		backdropPath: text('backdrop_path'),
		rating: real('rating'),
		runtime: integer('runtime'),
		releasedOn: text('released_on'),
		seasons: integer('seasons'),
		production: text('production', { enum: ['in_production', 'ended'] }),
		genres: text('genres'),
		crew: text('crew'),
		cast: text('cast'),
		trailer: text('trailer'),
		updatedAt: integer('updated_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date())
	},
	(table) => [index('share_previews_title_type_idx').on(table.titleType)]
);

export type SharePreviewRow = typeof sharePreviews.$inferSelect;

/** One row per warm purely to count the per-account hourly cap, which can't live on the shared preview rows. */
export const sharePreviewWarms = sqliteTable(
	'share_preview_warms',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date())
	},
	(table) => [index('share_preview_warms_user_created_idx').on(table.userId, table.createdAt)]
);

export type SharePreviewWarmRow = typeof sharePreviewWarms.$inferSelect;

/** No foreign keys on purpose: audit rows must outlive the account they act on. */
export const adminAudit = sqliteTable(
	'admin_audit',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		actorUserId: text('actor_user_id').notNull(),
		actorEmail: text('actor_email').notNull(),
		action: text('action').notNull(),
		targetType: text('target_type').notNull(),
		targetId: text('target_id').notNull(),
		targetLabel: text('target_label'),
		reason: text('reason'),
		metadata: text('metadata'),
		ip: text('ip'),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date())
	},
	(table) => [
		index('admin_audit_created_at_idx').on(table.createdAt),
		index('admin_audit_target_idx').on(table.targetType, table.targetId)
	]
);
