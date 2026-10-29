import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { requireAdmin } from '#lib/server/admin/guard.js';
import { countUsersByStatus } from '#lib/server/admin/metrics.js';

export const load: PageServerLoad = async ({ locals }) => {
	requireAdmin(locals.user);
	if (!locals.db) error(503, 'Service unavailable');

	return { counts: await countUsersByStatus(locals.db) };
};
