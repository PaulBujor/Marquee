import { error, redirect } from '@sveltejs/kit';
import { setSessionCookie, verifyMagicLink } from '$lib/server/auth';
import type { RequestHandler } from './$types';

// Single-use token in the query string (keeps the email link no-JS friendly);
// expires in 15 minutes and is never logged.
export const GET: RequestHandler = async ({ url, locals, cookies }) => {
	if (!locals.db) error(503, 'Service unavailable');

	const token = url.searchParams.get('token');
	if (!token) redirect(303, '/login?error=invalid');

	const result = await verifyMagicLink(locals.db, token);
	if (!result.ok) redirect(303, `/login?error=${result.reason}`);

	setSessionCookie(cookies, result.token, result.expiresAt);
	redirect(303, '/');
};
