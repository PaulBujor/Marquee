import type { LayoutServerLoad } from './$types';

/** `blockedReason` is an operator note: it must never reach the SSR payload or the SW's page cache. */
export const load: LayoutServerLoad = async ({ locals }) => {
	return {
		user: locals.user ? { id: locals.user.id, email: locals.user.email } : null,
		isAdmin: locals.user?.role === 'admin'
	};
};
