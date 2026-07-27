import { redirect } from '@sveltejs/kit';
import { EMAIL_CHANGE_TTL_MINUTES } from '$lib/email-change';
import type { PageLoad } from './$types';

/**
 * Universal (not server) load so the settings page works **offline**: it needs no network — just the
 * signed-in `user` (from the cached layout data via `parent()`) and a display constant. A server
 * load here would make an offline client-side navigation fail (SvelteKit can't fetch its
 * `__data.json`). The account actions stay in `+page.server.ts` (they need the server, and the UI
 * gates them offline).
 */
export const load: PageLoad = async ({ parent }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/login');
	return { user, codeTtlMinutes: EMAIL_CHANGE_TTL_MINUTES };
};
