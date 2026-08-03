/**
 * Auth-hygiene sweep (MRQ-97): delete rows that no longer serve any purpose so the tables don't grow
 * unbounded — consumed or expired `login_tokens`, and expired `sessions`. Neither is a correctness
 * issue (the rate-limit window queries and session validation both filter by time already); this is
 * pure storage hygiene, run from the nightly cron alongside the media refresh.
 */
import { isNotNull, lt } from 'drizzle-orm';
import type { createDb } from '$lib/server/db';
import { loginTokens, sessions } from '$lib/server/db/schema';

type Db = ReturnType<typeof createDb>;

/** How many rows each table's sweep removed. */
export interface AuthPurgeResult {
	loginTokens: number;
	sessions: number;
}

/**
 * Delete expired/consumed login tokens and expired sessions as one all-or-nothing `db.batch`
 * (D1 has no interactive transactions). `now` is injectable for tests. Cheap and idempotent.
 *
 * The login-token purge is two separate indexed deletes (expired-by-time, then already-consumed)
 * rather than one `OR`-across-columns delete — `login_tokens_expires_at_idx` /
 * `login_tokens_consumed_at_idx` each cover one branch; an unindexed OR would scan the table
 * (rows already removed by the first delete simply don't match the second).
 */
export async function purgeExpiredAuth(db: Db, now: number = Date.now()): Promise<AuthPurgeResult> {
	const cutoff = new Date(now);
	const [expired, consumed, sess] = await db.batch([
		db
			.delete(loginTokens)
			.where(lt(loginTokens.expiresAt, cutoff))
			.returning({ id: loginTokens.id }),
		db
			.delete(loginTokens)
			.where(isNotNull(loginTokens.consumedAt))
			.returning({ id: loginTokens.id }),
		db.delete(sessions).where(lt(sessions.expiresAt, cutoff)).returning({ id: sessions.id })
	]);
	return { loginTokens: expired.length + consumed.length, sessions: sess.length };
}
