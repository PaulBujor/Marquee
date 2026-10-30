import { redirect } from '@sveltejs/kit';
import { deleteSessionCookie, invalidateSession, SESSION_COOKIE } from '#lib/server/auth/index.js';
import { env } from '#lib/server/bindings.js';
import type { Actions } from './$types';

export const actions: Actions = {
	logout: async ({ locals, cookies }) => {
		const token = cookies.get(SESSION_COOKIE);
		if (token && locals.db) await invalidateSession(locals.db, token);
		deleteSessionCookie(cookies, env.PREVIEW_COOKIE_DOMAIN);
		redirect(303, '/login');
	}
};
