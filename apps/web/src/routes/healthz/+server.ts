import { json } from '@sveltejs/kit';
import { isDbReachable } from '#lib/server/health.js';
import type { RequestHandler } from './$types';

// Readiness probe: exercises D1 rather than trusting the guard, and never leaks internals (see AGENTS.md).
export const GET: RequestHandler = async ({ locals }) => {
	if (locals.db && (await isDbReachable(locals.db))) {
		return json({ status: 'ok' });
	}
	return json({ status: 'unavailable' }, { status: 503 });
};
