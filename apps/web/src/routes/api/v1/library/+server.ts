import { json } from '@sveltejs/kit';
import { authenticateApiToken } from '#lib/server/api/auth.js';
import { problem } from '#lib/server/http/problem.js';
import {
	InvalidLibraryCursorError,
	LIBRARY_PAGE_MAX,
	readLibraryPage
} from '#lib/server/library/read.js';
import type { RequestHandler } from './$types';

/** A page of the caller's library. The token is the only source of the user id. */
export const GET: RequestHandler = async ({ request, locals, url }) => {
	if (!locals.db) return problem(503, 'Service unavailable');

	const identity = await authenticateApiToken(request, locals.db);
	if (!identity)
		return problem(401, 'Unauthorized', {
			detail: 'A valid bearer token is required.',
			headers: { 'www-authenticate': 'Bearer' }
		});

	const rawLimit = url.searchParams.get('limit');
	const limit = rawLimit === null ? undefined : Number(rawLimit);
	if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= LIBRARY_PAGE_MAX))
		return problem(400, 'Invalid query parameters', {
			detail: `limit must be an integer from 1 to ${LIBRARY_PAGE_MAX}.`
		});

	try {
		return json(
			await readLibraryPage(locals.db, identity.userId, {
				limit,
				cursor: url.searchParams.get('cursor')
			})
		);
	} catch (err) {
		if (err instanceof InvalidLibraryCursorError)
			return problem(400, 'Invalid cursor', {
				type: 'invalid_cursor',
				detail: 'The cursor is not one this endpoint issued.'
			});
		throw err;
	}
};
