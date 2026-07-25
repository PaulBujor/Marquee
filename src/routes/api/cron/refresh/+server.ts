import { error, json } from '@sveltejs/kit';
import { createTmdbClient } from '$lib/server/tmdb';
import { refreshInProductionShows } from '$lib/server/media/cron';
import type { RequestHandler } from './$types';

/**
 * The nightly media-refresh sweep. The cron `scheduled` handler self-`fetch`es this route (see
 * scripts/append-cron.mjs); it's HTTP-reachable and gated by `CRON_SECRET`, so it also doubles as a
 * manual trigger — `POST` it with an `x-cron-key: <CRON_SECRET>` header to force a refresh.
 */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const secret = platform?.env.CRON_SECRET;
	if (!secret || request.headers.get('x-cron-key') !== secret) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');
	const apiKey = platform?.env.TMDB_API_KEY;
	if (!apiKey) error(503, 'TMDB is not configured.');

	const result = await refreshInProductionShows(locals.db, createTmdbClient(apiKey));
	console.log(`cron: scanned ${result.scanned} in-production shows, ${result.changed} changed`);
	return json(result);
};
