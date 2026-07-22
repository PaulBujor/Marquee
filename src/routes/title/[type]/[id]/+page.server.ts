import { error, redirect } from '@sveltejs/kit';
import { createTmdbClient, TmdbError } from '$lib/server/tmdb';
import type { PageServerLoad } from './$types';

/**
 * Read-only media detail for `/title/{type}/{id}` — overview, cast, images, trailer, rating,
 * runtime, genres from TMDB. Auth-gated (mirrors search). Display-only: no tracking writes.
 */
export const load: PageServerLoad = async ({ locals, params, platform, url }) => {
	if (!locals.user) redirect(303, '/login');

	const type = params.type === 'movie' || params.type === 'show' ? params.type : null;
	const id = Number(params.id);
	if (!type || !Number.isInteger(id) || id <= 0) error(404, 'Not found.');

	if (!platform) error(503, 'Service unavailable.');
	const apiKey = platform.env.TMDB_API_KEY;
	if (!apiKey) error(503, 'Media details are not configured.');

	try {
		const client = createTmdbClient(apiKey);
		const detail = await client.getDetails(type, id);

		// For shows, load one season's episodes: the `?season=N` param when it names a real
		// season, else the first non-Specials season (or the first season TMDB lists).
		if (detail.type === 'show' && detail.seasons.length > 0) {
			// `Number(null)` is 0, so guard the absent/blank param before parsing (else it would
			// match the Specials season). NaN never matches, falling through to the default.
			const raw = url.searchParams.get('season');
			const requested = raw && raw.trim() !== '' ? Number(raw) : NaN;
			const selectable =
				detail.seasons.find((s) => s.seasonNumber === requested) ??
				detail.seasons.find((s) => s.seasonNumber >= 1) ??
				detail.seasons[0];
			const season = await client.getSeason(id, selectable.seasonNumber);
			return { detail, season };
		}

		return { detail, season: null };
	} catch (err) {
		if (err instanceof TmdbError) {
			console.error('TMDB getDetails failed:', err.status, err.message);
			// A missing title is a clean 404; anything else is an upstream failure.
			error(
				err.status === 404 ? 404 : 502,
				err.status === 404 ? 'Not found.' : 'Could not load this title.'
			);
		}
		throw err;
	}
};
