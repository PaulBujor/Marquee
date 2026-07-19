import { json } from '@sveltejs/kit';
import { isDbReachable } from '$lib/server/health';
import type { RequestHandler } from './$types';

// Generic readiness probe for uptime/observability. Exercises the critical dependency
// (D1) rather than merely checking the guard; never leaks internals in the body.
// See AGENTS.md for the readiness-vs-`locals.db`-guard distinction.
export const GET: RequestHandler = async ({ locals }) => {
	if (locals.db && (await isDbReachable(locals.db))) {
		return json({ status: 'ok' });
	}
	return json({ status: 'unavailable' }, { status: 503 });
};
