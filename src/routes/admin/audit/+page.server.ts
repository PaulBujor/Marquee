import { error } from '@sveltejs/kit';
import { desc, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireAdmin } from '#lib/server/admin/guard.js';
import { adminAudit } from '#lib/server/db/schema.js';

const PAGE_SIZE = 50;

export const load: PageServerLoad = async ({ locals, url }) => {
	requireAdmin(locals.user);
	if (!locals.db) error(503, 'Service unavailable');

	const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);

	const [rows, [totals]] = await Promise.all([
		locals.db
			.select()
			.from(adminAudit)
			.orderBy(desc(adminAudit.createdAt))
			.limit(PAGE_SIZE)
			.offset((page - 1) * PAGE_SIZE),
		locals.db.select({ total: sql<number>`count(*)` }).from(adminAudit)
	]);

	return { rows, page, pageSize: PAGE_SIZE, total: Number(totals?.total ?? 0) };
};
