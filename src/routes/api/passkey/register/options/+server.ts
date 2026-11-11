import { error, json } from '@sveltejs/kit';
import {
	PASSKEY_ENROLL_COOKIE,
	requireRecentSignIn,
	setChallengeCookie,
	startRegistration
} from '#lib/server/auth/passkey.js';
import { problem } from '#lib/server/http/problem.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, url, cookies, getClientAddress }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');

	// A credential outlives every session, so a live cookie alone is not enough to enrol one.
	const denied = requireRecentSignIn(locals);
	if (denied) return denied;

	const result = await startRegistration(locals.db, locals.user, url, {
		ip: getClientAddress(),
		previousChallengeId: cookies.get(PASSKEY_ENROLL_COOKIE)
	});
	if (!result)
		return problem(429, 'Too many passkey attempts', {
			detail: 'Too many enrolment ceremonies are open. Try again in a few minutes.'
		});

	setChallengeCookie(cookies, PASSKEY_ENROLL_COOKIE, result.challengeId);
	return json(result.options);
};
