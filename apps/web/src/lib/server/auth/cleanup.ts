import { isNotNull, lt, or } from 'drizzle-orm';
import type { createDb } from '#lib/server/db/index.js';
import {
	apiTokens,
	loginTokens,
	notificationLog,
	passkeyChallenges,
	sessions
} from '#lib/server/db/schema.js';
import { GRACE_DAYS } from '#lib/server/push/digest.js';

type Db = ReturnType<typeof createDb>;

/** Kept well past `GRACE_DAYS` (the digest's lookup window) so a run delayed by an outage still dedupes. */
const NOTIFICATION_LOG_RETENTION_DAYS = GRACE_DAYS + 28;

/** How long a revoked or expired API token stays for attribution before it (not its `events`) is deleted. */
export const API_TOKEN_RETENTION_DAYS = 30;

export interface AuthPurgeResult {
	loginTokens: number;
	sessions: number;
	passkeyChallenges: number;
	notifications: number;
	apiTokens: number;
}

/** One `db.batch` because D1 has no interactive transactions; `now` is injectable for tests. */
export async function purgeExpiredAuth(db: Db, now: number = Date.now()): Promise<AuthPurgeResult> {
	const cutoff = new Date(now);
	const notificationCutoff = new Date(now - NOTIFICATION_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
	const tokenCutoff = new Date(now - API_TOKEN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
	const [expired, consumed, sess, challenges, notifications, tokens] = await db.batch([
		db
			.delete(loginTokens)
			.where(lt(loginTokens.expiresAt, cutoff))
			.returning({ id: loginTokens.id }),
		db
			.delete(loginTokens)
			.where(isNotNull(loginTokens.consumedAt))
			.returning({ id: loginTokens.id }),
		db.delete(sessions).where(lt(sessions.expiresAt, cutoff)).returning({ id: sessions.id }),
		db
			.delete(passkeyChallenges)
			.where(lt(passkeyChallenges.expiresAt, cutoff))
			.returning({ id: passkeyChallenges.id }),
		db
			.delete(notificationLog)
			.where(lt(notificationLog.sentAt, notificationCutoff))
			.returning({ id: notificationLog.id }),
		// Null comparisons are unknown in SQL, so a live token (both stamps null) never matches.
		db
			.delete(apiTokens)
			.where(or(lt(apiTokens.revokedAt, tokenCutoff), lt(apiTokens.expiresAt, tokenCutoff)))
			.returning({ id: apiTokens.id })
	]);
	return {
		loginTokens: expired.length + consumed.length,
		sessions: sess.length,
		passkeyChallenges: challenges.length,
		notifications: notifications.length,
		apiTokens: tokens.length
	};
}
