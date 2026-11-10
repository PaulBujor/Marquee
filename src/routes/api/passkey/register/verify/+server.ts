import { error, json } from '@sveltejs/kit';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import {
	clearChallengeCookie,
	finishRegistration,
	PASSKEY_CHALLENGE_COOKIE,
	registrationBodySchema
} from '#lib/server/auth/passkey.js';
import { problem, zodProblem } from '#lib/server/http/problem.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, url, cookies, request }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');

	const raw: unknown = await request.json().catch(() => undefined);
	if (raw === undefined)
		return problem(400, 'Malformed request body', { detail: 'Body must be valid JSON.' });
	const parsed = registrationBodySchema.safeParse(raw);
	if (!parsed.success) return zodProblem(parsed.error);

	const ok = await finishRegistration({
		db: locals.db,
		user: locals.user,
		url,
		challengeId: cookies.get(PASSKEY_CHALLENGE_COOKIE),
		// SAFETY: `response` is a whole WebAuthn response; only `id`/`type` are shape-checked here
		// because `verifyRegistrationResponse` validates every other field itself.
		response: parsed.data.response as unknown as RegistrationResponseJSON,
		name: parsed.data.name || 'Passkey'
	});
	clearChallengeCookie(cookies);

	if (!ok) return problem(400, 'Passkey registration failed');
	return json({ ok: true }, { status: 201 });
};
