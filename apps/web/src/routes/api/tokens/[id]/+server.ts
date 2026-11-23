import { error, json } from '@sveltejs/kit';
import { revokeApiToken } from '#lib/server/api/tokens.js';
import { problem } from '#lib/server/http/problem.js';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');

	const revoked = await revokeApiToken(locals.db, locals.user.id, params.id);
	if (!revoked) return problem(404, 'Token not found');
	return json({ token: revoked });
};
