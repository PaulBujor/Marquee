import { error, json } from '@sveltejs/kit';
import { listSubscriptions } from '$lib/server/push/subscriptions';
import type { RequestHandler } from './$types';

/** List the caller's own push subscriptions for the settings device list. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');
	return json({ subscriptions: await listSubscriptions(locals.db, locals.user.id) });
};
