import type { LayoutServerLoad } from './$types';

/**
 * Only what the client actually uses. `locals.user` is the whole ORM row, which also carries
 * `signupIp`, `blockedReason`, `status` and the timestamps — none of it needed in the browser, and
 * all of it otherwise serialized into every page's SSR payload *and* written to disk by the
 * service worker's `pages-*` navigation cache. `blockedReason` in particular is an operator note,
 * never intended for the account holder to read.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
	return {
		user: locals.user ? { id: locals.user.id, email: locals.user.email } : null
	};
};
