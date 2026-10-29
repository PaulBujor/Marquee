import { env } from '#lib/server/bindings.js';
import { error, json } from '@sveltejs/kit';
import { createTmdbClient, TmdbError } from '#lib/server/tmdb/index.js';
import type { RequestHandler } from './$types';

/** TMDB returns credits unpaginated, so the client asks for `?page=N` rather than pulling a whole filmography. */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	if (!locals.user) error(401, 'Unauthorized.');

	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Not found.');

	const rawPage = Number(url.searchParams.get('page'));
	const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;

	if (!env) error(503, 'Service unavailable.');
	const apiKey = env.TMDB_API_KEY;
	if (!apiKey) error(503, 'Person details are not configured.');

	try {
		return json(await createTmdbClient(apiKey).getPerson(id, page));
	} catch (err) {
		if (err instanceof TmdbError) {
			console.error('TMDB getPerson failed:', err.status, err.message);
			error(
				err.status === 404 ? 404 : 502,
				err.status === 404 ? 'Not found.' : 'Could not load this person.'
			);
		}
		throw err;
	}
};
