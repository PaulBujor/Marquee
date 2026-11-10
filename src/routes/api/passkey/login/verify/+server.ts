import { error, json } from '@sveltejs/kit';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { env } from '#lib/server/bindings.js';
import {
	authenticationBodySchema,
	clearChallengeCookie,
	finishAuthentication,
	PASSKEY_CHALLENGE_COOKIE
} from '#lib/server/auth/passkey.js';
import { createSession, setSessionCookie } from '#lib/server/auth/session.js';
import { problem, zodProblem } from '#lib/server/http/problem.js';
import { safeRedirectPath } from '#lib/redirect.js';
import type { RequestHandler } from './$types';

/** Public: this is the sign-in. The assertion is signed by the credential's private key. */
export const POST: RequestHandler = async ({ locals, url, cookies, request }) => {
	if (!locals.db) error(503, 'Service unavailable');

	const raw: unknown = await request.json().catch(() => undefined);
	if (raw === undefined)
		return problem(400, 'Malformed request body', { detail: 'Body must be valid JSON.' });
	const parsed = authenticationBodySchema.safeParse(raw);
	if (!parsed.success) return zodProblem(parsed.error);

	const result = await finishAuthentication({
		db: locals.db,
		url,
		challengeId: cookies.get(PASSKEY_CHALLENGE_COOKIE),
		// SAFETY: `response` is a whole WebAuthn response; only `id`/`type` are shape-checked here
		// because `verifyAuthenticationResponse` validates every other field itself.
		response: parsed.data.response as unknown as AuthenticationResponseJSON
	});
	clearChallengeCookie(cookies);

	if (!result.ok) {
		return result.reason === 'not_allowed'
			? problem(403, 'Account unavailable')
			: problem(400, 'Passkey sign-in failed');
	}

	const { token, expiresAt } = await createSession(locals.db, result.user.id);
	setSessionCookie(cookies, token, expiresAt, env.PREVIEW_COOKIE_DOMAIN);
	return json({ redirectTo: safeRedirectPath(parsed.data.redirectTo) });
};
