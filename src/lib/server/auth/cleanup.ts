/**
 * Auth-hygiene sweep: delete rows that no longer serve any purpose so the tables don't grow
 * unbounded — consumed or expired `login_tokens`, and expired `sessions`. Neither is a correctness
 * issue (the rate-limit window queries and session validation both filter by time already); this is
 * pure storage hygiene, run from the nightly cron alongside the media refresh.
 */
import { isNotNull, lt, or } from 'drizzle-orm';
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
 */
export async function purgeExpiredAuth(db: Db, now: number = Date.now()): Promise<AuthPurgeResult> {
	const cutoff = new Date(now);
	const [tokens, sess] = await db.batch([
		db
			.delete(loginTokens)
			.where(or(lt(loginTokens.expiresAt, cutoff), isNotNull(loginTokens.consumedAt)))
			.returning({ id: loginTokens.id }),
		db.delete(sessions).where(lt(sessions.expiresAt, cutoff)).returning({ id: sessions.id })
	]);
	return { loginTokens: tokens.length, sessions: sess.length };
}
