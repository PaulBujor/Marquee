import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** The SW's background flush drains only this id's outbox: pushing another account's store would cross accounts. */
export const GET: RequestHandler = ({ locals }) => {
	if (!locals.user) return new Response(null, { status: 401 });
	return json({ userId: locals.user.id });
};
