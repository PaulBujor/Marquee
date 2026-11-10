import { error, json } from '@sveltejs/kit';
import { setChallengeCookie, startRegistration } from '#lib/server/auth/passkey.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, url, cookies }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');

	const { options, challengeId } = await startRegistration(locals.db, locals.user, url);
	setChallengeCookie(cookies, challengeId);
	return json(options);
};
