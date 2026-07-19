import { error, json } from '@sveltejs/kit';
import { createTmdbClient, TmdbError } from '$lib/server/tmdb';
import type { RequestHandler } from './$types';

/**
 * Live TMDB search (no cache — MRQ-36). Auth-gated JSON endpoint the `/search` page fetches
 * as the user types. The API key stays server-side; the browser only ever hits this route.
 */
export const GET: RequestHandler = async ({ url, locals, platform }) => {
	if (!locals.user) error(401, 'Sign in to search.');
	if (!platform) error(503, 'Service unavailable.');

	const apiKey = platform.env.TMDB_API_KEY;
	if (!apiKey) error(503, 'Search is not configured.');

	const query = url.searchParams.get('q')?.trim() ?? '';
	if (!query) return json({ results: [] });

	try {
		const results = await createTmdbClient(apiKey).search(query);
		return json({ results });
	} catch (err) {
		if (err instanceof TmdbError) {
			console.error('TMDB search failed:', err.status, err.message);
			error(502, 'Search is unavailable right now.');
		}
		throw err;
	}
};
