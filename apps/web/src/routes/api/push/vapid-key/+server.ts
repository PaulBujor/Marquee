import { env } from '#lib/server/bindings.js';
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Public by nature, but auth-gated to keep the push surface behind a session. */
export const GET: RequestHandler = ({ locals }) => {
	if (!locals.user) error(401, 'Unauthorized');
	const publicKey = env.VAPID_PUBLIC_KEY;
	if (!publicKey) error(503, 'Push notifications are not configured');
	return json({ publicKey });
};
