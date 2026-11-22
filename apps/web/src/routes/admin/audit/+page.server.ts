import { error } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireAdmin } from '#lib/server/admin/guard.js';
import { orderBy, parseSort } from '#lib/server/admin/sort.js';
import { adminAudit } from '#lib/server/db/schema.js';

const PAGE_SIZE = 50;

// The only columns a `?sort=` value can reach: parseSort looks up this map, never the raw string.
const SORTS = {
	createdAt: adminAudit.createdAt,
	action: adminAudit.action,
	actorEmail: adminAudit.actorEmail
} as const;
const SORT_KEYS = Object.keys(SORTS) as (keyof typeof SORTS)[];

export const load: PageServerLoad = async ({ locals, url }) => {
	requireAdmin(locals.user);
	if (!locals.db) error(503, 'Service unavailable');

	const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
	const sort = parseSort(url.searchParams.get('sort'), SORT_KEYS, {
		key: 'createdAt',
		dir: 'desc'
	});

	const [rows, [totals]] = await Promise.all([
		locals.db
			.select()
			.from(adminAudit)
			.orderBy(orderBy(SORTS, sort))
			.limit(PAGE_SIZE)
			.offset((page - 1) * PAGE_SIZE),
		locals.db.select({ total: sql<number>`count(*)` }).from(adminAudit)
	]);

	return { rows, page, pageSize: PAGE_SIZE, total: Number(totals?.total ?? 0), sort };
};
