import type { LayoutServerLoad } from './$types';
import { requireAdmin } from '#lib/server/admin/guard.js';

// Each action re-checks for itself: an action can be POSTed without loading this layout.
export const load: LayoutServerLoad = async ({ locals }) => {
	const admin = requireAdmin(locals.user);
	return { admin: { id: admin.id, email: admin.email } };
};
