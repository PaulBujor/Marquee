import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * Universal, like every offline-reachable page: a server load's `__data.json` can't be fetched, so
 * a `+page.server.ts` would fail the navigation outright. The log itself is read in the component,
 * from IndexedDB.
 */
export const load: PageLoad = async ({ parent }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/login');
	return { user };
};
