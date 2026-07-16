import type { Handle } from '@sveltejs/kit';
import { createDb } from '$lib/server/db';

export const handle: Handle = async ({ event, resolve }) => {
	if (event.platform) {
		event.locals.db = createDb(event.platform.env.DB);
	}
	return resolve(event);
};
