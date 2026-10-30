import { error } from '@sveltejs/kit';
import { and, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireAdmin } from '#lib/server/admin/guard.js';
import { orderBy, parseSort } from '#lib/server/admin/sort.js';
import { users, USER_STATUSES, type UserStatus } from '#lib/server/db/schema.js';

const PAGE_SIZE = 25;

// The only columns a `?sort=` value can reach: parseSort looks up this map, never the raw string.
const SORTS = {
	createdAt: users.createdAt,
	email: users.email,
	status: users.status,
	role: users.role
} as const;
const SORT_KEYS = Object.keys(SORTS) as (keyof typeof SORTS)[];

function parseStatus(raw: string | null): UserStatus | null {
	return USER_STATUSES.includes(raw as UserStatus) ? (raw as UserStatus) : null;
}

/** Search terms reach a LIKE pattern, so `%` and `_` are escaped to stay literal. */
function escapeLike(term: string): string {
	return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export const load: PageServerLoad = async ({ locals, url }) => {
	requireAdmin(locals.user);
	if (!locals.db) error(503, 'Service unavailable');

	const status = parseStatus(url.searchParams.get('status'));
	const deletedOnly = url.searchParams.get('status') === 'deleted';
	const q = (url.searchParams.get('q') ?? '').trim();
	const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
	const sort = parseSort(url.searchParams.get('sort'), SORT_KEYS, {
		key: 'createdAt',
		dir: 'desc'
	});

	const filters: SQL[] = [deletedOnly ? isNotNull(users.deletedAt) : isNull(users.deletedAt)];
	if (status) filters.push(eq(users.status, status));
	if (q) filters.push(sql`${users.email} LIKE ${`%${escapeLike(q)}%`} ESCAPE '\\'`);
	const where = filters.length ? and(...filters) : undefined;

	const [rows, [totals]] = await Promise.all([
		locals.db
			.select({
				id: users.id,
				email: users.email,
				status: users.status,
				role: users.role,
				blockedReason: users.blockedReason,
				deletedAt: users.deletedAt,
				signupIp: users.signupIp,
				createdAt: users.createdAt
			})
			.from(users)
			.where(where)
			.orderBy(orderBy(SORTS, sort))
			.limit(PAGE_SIZE)
			.offset((page - 1) * PAGE_SIZE),
		locals.db
			.select({ total: sql<number>`count(*)` })
			.from(users)
			.where(where)
	]);

	return {
		rows,
		page,
		pageSize: PAGE_SIZE,
		total: Number(totals?.total ?? 0),
		status,
		deletedOnly,
		q,
		sort
	};
};
