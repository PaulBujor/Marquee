import { error, redirect } from '@sveltejs/kit';
import { setSessionCookie, verifyMagicLink } from '$lib/server/auth';
import type { RequestHandler } from './$types';

// The token rides in the query string so the email link works without JS. We
// never log it (here or in the auth layer), it's single-use and expires in 15
// minutes, and Referrer-Policy keeps it out of outbound referers — so a token
// captured in infra request logs is already spent. Do not add logging that
// includes `url` / `token`.
export const GET: RequestHandler = async ({ url, locals, cookies }) => {
	if (!locals.db) error(503, 'Service unavailable');

	const token = url.searchParams.get('token');
	if (!token) redirect(303, '/login?error=invalid');

	const result = await verifyMagicLink(locals.db, token);
	if (!result.ok) redirect(303, `/login?error=${result.reason}`);

	setSessionCookie(cookies, result.token, result.expiresAt);
	redirect(303, '/');
};
