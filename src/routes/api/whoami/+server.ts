import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * Minimal identity probe: reports which user the session cookie authenticates as. The service
 * worker's background-sync flush uses it to drain **only that user's** local outbox when no tab is
 * open — never another account's store on a shared device (the server attributes pushed events to
 * this id, so pushing the wrong store would cross accounts). 401 when signed out.
 */
export const GET: RequestHandler = ({ locals }) => {
	if (!locals.user) return new Response(null, { status: 401 });
	return json({ userId: locals.user.id });
};
