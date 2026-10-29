import { env } from '#lib/server/bindings.js';
import { error, json } from '@sveltejs/kit';
import { createTmdbClient, TmdbError } from '#lib/server/tmdb/index.js';
import type { RequestHandler } from './$types';

/**
 * Season episodes as JSON, fetched client-side by the detail page so switching seasons never
 * touches the URL or browser history. Auth-gated; the TMDB key stays server-side.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) error(401, 'Unauthorized.');

	const id = Number(params.id);
	const seasonNumber = Number(params.season);
	if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(seasonNumber) || seasonNumber < 0) {
		error(404, 'Not found.');
	}

	if (!env) error(503, 'Service unavailable.');
	const apiKey = env.TMDB_API_KEY;
	if (!apiKey) error(503, 'Media details are not configured.');

	try {
		const season = await createTmdbClient(apiKey).getSeason(id, seasonNumber);
		return json(season);
	} catch (err) {
		if (err instanceof TmdbError) {
			console.error('TMDB getSeason failed:', err.status, err.message);
			error(err.status === 404 ? 404 : 502, err.status === 404 ? 'Not found.' : 'Could not load.');
		}
		throw err;
	}
};
