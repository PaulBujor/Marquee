import { env } from '#lib/server/bindings.js';
import { error, json } from '@sveltejs/kit';
import { enqueueImdbAliasCandidates } from '#lib/server/media/imdb-aliases.js';
import type { ImdbAliasMessage } from '#lib/server/media/imdb-aliases.js';
import { cloudflareQueueProducer } from '#lib/server/queue/cloudflare.js';
import { isAuthorizedCronRequest } from '#lib/server/http/secret.js';
import type { RequestHandler } from './$types';

/**
 * Producer only — the `IMDB_ALIAS_QUEUE` consumer makes the one TMDB request per title (see
 * `scripts/append-cron.mjs`); `x-cron-key: <CRON_SECRET>` also runs it on demand.
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

	// Same reasoning as the refresh route: with no key every message 503s, so enqueueing would only
	// push the whole backlog into the DLQ behind a success-looking run.
	if (!env.TMDB_API_KEY) {
		console.error('cron: skipping IMDb alias enqueue — TMDB is not configured.');
		return json({ ok: false, error: 'TMDB is not configured.' });
	}

	const result = await enqueueImdbAliasCandidates(
		locals.db,
		cloudflareQueueProducer<ImdbAliasMessage>(env.IMDB_ALIAS_QUEUE)
	);
	console.log(
		`cron: ${result.scanned} titles never asked for an IMDb id, enqueued ${result.queued}` +
			`${result.capped ? ' (capped; remainder rolls to the next run)' : ''}`
	);

	return json({ ok: true, ...result });
};
