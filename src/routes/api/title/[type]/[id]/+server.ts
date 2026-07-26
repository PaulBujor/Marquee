import { error, json } from '@sveltejs/kit';
import { createTmdbClient, TmdbError } from '$lib/server/tmdb';
import type { RequestHandler } from './$types';

/**
 * Media detail (+ one season's episodes for shows) as JSON, fetched by the title page's universal
 * load. Keeping the TMDB call behind an API route lets the page be a universal `+page.ts` that can
 * fall back to IndexedDB when this is unreachable (offline) — so a tracked title still renders.
 * Auth-gated; the TMDB key stays server-side. `?season=N` selects which season's episodes to embed.
 */
export const GET: RequestHandler = async ({ locals, params, platform, url }) => {
	if (!locals.user) error(401, 'Unauthorized.');

	const type = params.type === 'movie' || params.type === 'show' ? params.type : null;
	const id = Number(params.id);
	if (!type || !Number.isInteger(id) || id <= 0) error(404, 'Not found.');

	if (!platform) error(503, 'Service unavailable.');
	const apiKey = platform.env.TMDB_API_KEY;
	if (!apiKey) error(503, 'Media details are not configured.');

	try {
		const client = createTmdbClient(apiKey);
		const detail = await client.getDetails(type, id);

		// For shows, embed one season's episodes: the `?season=N` param when it names a real season,
		// else the first non-Specials season (or the first TMDB lists).
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
