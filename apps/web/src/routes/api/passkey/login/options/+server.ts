import { error, json } from '@sveltejs/kit';
import {
	PASSKEY_COOKIE,
	setChallengeCookie,
	startAuthentication
} from '#lib/server/auth/passkey.js';
import { problem } from '#lib/server/http/problem.js';
import type { RequestHandler } from './$types';

/** Public: the whole point is that nobody has identified themselves yet. */
export const POST: RequestHandler = async ({ locals, url, cookies, getClientAddress }) => {
	if (!locals.db) error(503, 'Service unavailable');

	const result = await startAuthentication(locals.db, url, {
		ip: getClientAddress(),
		// This browser's previous challenge is replaced, not left behind: every /login view mints one.
		previousChallengeId: cookies.get(PASSKEY_COOKIE)
	});
	if (!result)
		return problem(429, 'Too many passkey attempts', {
			detail: 'Too many sign-in ceremonies are open. Try again in a few minutes.'
		});

	setChallengeCookie(cookies, PASSKEY_COOKIE, result.challengeId);
	return json(result.options);
};
