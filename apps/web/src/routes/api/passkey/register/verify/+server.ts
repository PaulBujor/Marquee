import { error, json } from '@sveltejs/kit';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import {
	clearChallengeCookie,
	finishRegistration,
	PASSKEY_ENROLL_COOKIE,
	registrationBodySchema,
	requireRecentSignIn
} from '#lib/server/auth/passkey.js';
import { notifyPasskeyChange } from '#lib/server/auth/passkey-notify.js';
import { problem, zodProblem } from '#lib/server/http/problem.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, url, cookies, request }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');

	const denied = requireRecentSignIn(locals);
	if (denied) return denied;

	const raw: unknown = await request.json().catch(() => undefined);
	if (raw === undefined)
		return problem(400, 'Malformed request body', { detail: 'Body must be valid JSON.' });
	const parsed = registrationBodySchema.safeParse(raw);
	if (!parsed.success) return zodProblem(parsed.error);

	const name = parsed.data.name || 'Passkey';
	const ok = await finishRegistration({
		db: locals.db,
		user: locals.user,
		url,
		challengeId: cookies.get(PASSKEY_ENROLL_COOKIE),
		// SAFETY: `response` is a whole WebAuthn response; only `id`/`type` are shape-checked here
		// because `verifyRegistrationResponse` validates every other field itself.
		response: parsed.data.response as unknown as RegistrationResponseJSON,
		name
	});
	clearChallengeCookie(cookies, PASSKEY_ENROLL_COOKIE);

	if (!ok) return problem(400, 'Passkey registration failed');

	// Out-of-band, so a session that silently enrols its own passkey can't go unnoticed.
	notifyPasskeyChange(locals.user, 'added', name);
	return json({ ok: true }, { status: 201 });
};
