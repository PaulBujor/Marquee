import { env } from '#lib/server/bindings.js';
import { error, json } from '@sveltejs/kit';
import { createTmdbClient, TmdbError } from '#lib/server/tmdb/index.js';
import type { RequestHandler } from './$types';

/** Behind an API route so the universal `+page.ts` can fall back to IndexedDB when this is unreachable. */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	if (!locals.user) error(401, 'Unauthorized.');

	const type = params.type === 'movie' || params.type === 'show' ? params.type : null;
	const id = Number(params.id);
	if (!type || !Number.isInteger(id) || id <= 0) error(404, 'Not found.');

	if (!env) error(503, 'Service unavailable.');
	const apiKey = env.TMDB_API_KEY;
	if (!apiKey) error(503, 'Media details are not configured.');

	try {
		const client = createTmdbClient(apiKey);
		const detail = await client.getDetails(type, id);

		// `?season=N` when it names a real season, else the first non-Specials season.
		if (detail.type === 'show' && detail.seasons.length > 0) {
			const raw = url.searchParams.get('season');
			const requested = raw && raw.trim() !== '' ? Number(raw) : NaN;
			const selectable =
				detail.seasons.find((s) => s.seasonNumber === requested) ??
				detail.seasons.find((s) => s.seasonNumber >= 1) ??
				detail.seasons[0];
			const season = await client.getSeason(id, selectable.seasonNumber);
			return json({ detail, season });
		}

		return json({ detail, season: null });
	} catch (err) {
		if (err instanceof TmdbError) {
			console.error('TMDB getDetails failed:', err.status, err.message);
			error(
				err.status === 404 ? 404 : 502,
				err.status === 404 ? 'Not found.' : 'Could not load this title.'
			);
		}
		throw err;
	}
};
