import { redirect } from '@sveltejs/kit';
import { EMAIL_CHANGE_TTL_MINUTES } from '#lib/email-change.js';
import type { PageLoad } from './$types';

/** Universal so settings opens offline: a server load's `__data.json` can't be fetched, and the actions stay in `+page.server.ts`. */
export const load: PageLoad = async ({ parent }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/login');
	return { user, codeTtlMinutes: EMAIL_CHANGE_TTL_MINUTES };
};
