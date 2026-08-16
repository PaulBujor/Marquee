import { error, json } from '@sveltejs/kit';
import { createTmdbClient, TmdbError } from '$lib/server/tmdb';
import type { RequestHandler } from './$types';

/**
 * A person (cast or crew) with one page of their filmography, for the person page.
 * Auth-gated so the TMDB key stays server-side. `?page=N` walks the credits — TMDB returns them
 * unpaginated, so the client asks for a page rather than pulling a prolific actor's whole history.
 * Not cached and not available offline: like cast and trailers, this is a live TMDB-only surface.
 */
export const GET: RequestHandler = async ({ locals, params, platform, url }) => {
	if (!locals.user) error(401, 'Unauthorized.');

	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Not found.');

	const rawPage = Number(url.searchParams.get('page'));
	const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;

	if (!platform) error(503, 'Service unavailable.');
	const apiKey = platform.env.TMDB_API_KEY;
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
