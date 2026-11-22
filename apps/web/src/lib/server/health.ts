import { sql } from 'drizzle-orm';
import type { createDb } from './db';

type Db = ReturnType<typeof createDb>;

export async function isDbReachable(db: Db): Promise<boolean> {
	try {
		await db.run(sql`select 1`);
		return true;
	} catch (err) {
		console.error('healthz: database unreachable', err);
		return false;
	}
}
