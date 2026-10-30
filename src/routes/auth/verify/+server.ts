import { error, redirect } from '@sveltejs/kit';
import { setSessionCookie, verifyMagicLink } from '#lib/server/auth/index.js';
import { safeRedirectPath } from '#lib/redirect.js';
import type { RequestHandler } from './$types';

// Query string keeps the email link no-JS friendly; single-use, 15-minute TTL, never logged.
export const GET: RequestHandler = async ({ url, locals, cookies }) => {
	if (!locals.db) error(503, 'Service unavailable');

	const token = url.searchParams.get('token');
	if (!token) redirect(303, '/login?error=invalid');

	const result = await verifyMagicLink(locals.db, token);
	if (!result.ok) redirect(303, `/login?error=${result.reason}`);

	setSessionCookie(cookies, result.token, result.expiresAt);
	// Re-validated here: the query string is user-editable.
	redirect(303, safeRedirectPath(url.searchParams.get('redirectTo')));
};
