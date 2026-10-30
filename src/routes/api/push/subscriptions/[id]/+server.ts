import { error } from '@sveltejs/kit';
import { deleteSubscription } from '#lib/server/push/subscriptions.js';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');

	const deleted = await deleteSubscription(locals.db, locals.user.id, params.id);
	if (!deleted) error(404, 'Subscription not found');
	return new Response(null, { status: 204 });
};
