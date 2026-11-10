import { error, json } from '@sveltejs/kit';
import { removePasskey } from '#lib/server/auth/passkey.js';
import { problem } from '#lib/server/http/problem.js';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');

	if (!(await removePasskey(locals.db, locals.user.id, params.id)))
		return problem(404, 'Passkey not found');
	return json({ ok: true });
};
