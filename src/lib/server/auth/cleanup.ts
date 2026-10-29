import { isNotNull, lt } from 'drizzle-orm';
import type { createDb } from '#lib/server/db/index.js';
import { loginTokens, notificationLog, sessions } from '#lib/server/db/schema.js';
import { GRACE_DAYS } from '#lib/server/push/digest.js';

type Db = ReturnType<typeof createDb>;

/** Kept well past `GRACE_DAYS` (the digest's lookup window) so a run delayed by an outage still dedupes. */
const NOTIFICATION_LOG_RETENTION_DAYS = GRACE_DAYS + 28;

export interface AuthPurgeResult {
	loginTokens: number;
	sessions: number;
	notifications: number;
}

/** One `db.batch` because D1 has no interactive transactions; `now` is injectable for tests. */
export async function purgeExpiredAuth(db: Db, now: number = Date.now()): Promise<AuthPurgeResult> {
	const cutoff = new Date(now);
	const notificationCutoff = new Date(now - NOTIFICATION_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
	const [expired, consumed, sess, notifications] = await db.batch([
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
			.delete(notificationLog)
			.where(lt(notificationLog.sentAt, notificationCutoff))
			.returning({ id: notificationLog.id })
	]);
	return {
		loginTokens: expired.length + consumed.length,
		sessions: sess.length,
		notifications: notifications.length
	};
}
