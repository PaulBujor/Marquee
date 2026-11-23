import { env } from '#lib/server/bindings.js';
import { error, json } from '@sveltejs/kit';
import { backfillImdbAliases } from '#lib/server/media/imdb-aliases.js';
import { createTmdbClient } from '#lib/server/tmdb/index.js';
import { isAuthorizedCronRequest } from '#lib/server/http/secret.js';
import type { RequestHandler } from './$types';

/**
 * Self-`fetch`ed by the cron `scheduled` handler (see scripts/append-cron.mjs); `x-cron-key: <CRON_SECRET>`
 * also runs it on demand.
 *
 * Its own daily slot rather than a leg of the 06:00 sweep: this is a one-off backfill that spends a TMDB
 * request per title, so it must not lengthen maintenance, and it can be dropped from `triggers.crons`
 * on its own once the catalog is stamped.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!(await isAuthorizedCronRequest(request, env.CRON_SECRET))) {
		error(401, 'Unauthorized');
	}
	if (!locals.db) error(503, 'Service unavailable');

	// Same reasoning as the refresh route: with no key every title fails, so a 200 that stamped nothing
	// would read as a healthy run.
	const tmdbKey = env.TMDB_API_KEY;
	if (!tmdbKey) {
		console.error('cron: skipping IMDb alias backfill — TMDB is not configured.');
		return json({ ok: false, error: 'TMDB is not configured.' });
	}

	const result = await backfillImdbAliases(locals.db, createTmdbClient(tmdbKey));
	return json({ ok: true, ...result });
};
