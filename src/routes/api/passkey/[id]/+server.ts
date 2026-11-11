import { error, json } from '@sveltejs/kit';
import { listPasskeys, removePasskey, requireRecentSignIn } from '#lib/server/auth/passkey.js';
import { notifyPasskeyChange } from '#lib/server/auth/passkey-notify.js';
import { problem } from '#lib/server/http/problem.js';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');

	// Removing a credential is a security-relevant change, so it needs the same fresh sign-in as adding.
	const denied = requireRecentSignIn(locals);
	if (denied) return denied;

	// Read the label before the row goes: the notice should name the passkey that vanished.
	const target = (await listPasskeys(locals.db, locals.user.id)).find(
		(row) => row.id === params.id
	);
	if (!target) return problem(404, 'Passkey not found');

	if (!(await removePasskey(locals.db, locals.user.id, params.id)))
		return problem(404, 'Passkey not found');

	notifyPasskeyChange(locals.user, 'removed', target.name);
	return json({ ok: true });
};
