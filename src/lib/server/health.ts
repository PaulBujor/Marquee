import { sql } from 'drizzle-orm';
import type { createDb } from './db';

type Db = ReturnType<typeof createDb>;

/**
 * Confirms the database is reachable via a trivial `SELECT 1`.
 * Returns true on success, false on any error — the caller maps this to a
 * generic status and never surfaces the underlying error.
 */
export async function isDbReachable(db: Db): Promise<boolean> {
	try {
		await db.run(sql`select 1`);
		return true;
	} catch {
		return false;
	}
}
