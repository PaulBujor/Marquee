import { sql } from 'drizzle-orm';
import type { createDb } from '#lib/server/db/index.js';
import { users, type UserStatus } from '#lib/server/db/schema.js';

type Db = ReturnType<typeof createDb>;

export type StatusCounts = Record<UserStatus, number>;

const EMPTY: StatusCounts = { pending: 0, enabled: 0, blocked: 0 };

/** Cheap `GROUP BY` over the users table — counts only, no aggregation tables. */
export async function countUsersByStatus(db: Db): Promise<StatusCounts> {
	const rows = await db
		.select({ status: users.status, total: sql<number>`count(*)` })
		.from(users)
		.groupBy(users.status);

	const counts: StatusCounts = { ...EMPTY };
	for (const row of rows) counts[row.status] = Number(row.total);
	return counts;
}
