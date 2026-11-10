import { error, json } from '@sveltejs/kit';
import { setChallengeCookie, startAuthentication } from '#lib/server/auth/passkey.js';
import type { RequestHandler } from './$types';

/** Public: the whole point is that nobody has identified themselves yet. */
export const POST: RequestHandler = async ({ locals, url, cookies }) => {
	if (!locals.db) error(503, 'Service unavailable');

	const { options, challengeId } = await startAuthentication(locals.db, url);
	setChallengeCookie(cookies, challengeId);
	return json(options);
};
