import { redirect } from '@sveltejs/kit';
import {
	deleteSessionCookie,
	invalidateSession,
	sessionCookieDomain,
	SESSION_COOKIE
} from '#lib/server/auth/index.js';
import { env } from '#lib/server/bindings.js';
import type { Actions } from './$types';

export const actions: Actions = {
	logout: async ({ locals, cookies, url }) => {
		const token = cookies.get(SESSION_COOKIE);
		if (token && locals.db) await invalidateSession(locals.db, token);
		deleteSessionCookie(cookies, sessionCookieDomain(url.hostname, env.PREVIEW_COOKIE_DOMAIN));
		redirect(303, '/login');
	}
};
