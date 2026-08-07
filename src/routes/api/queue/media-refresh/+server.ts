import { error, json } from '@sveltejs/kit';
import { createTmdbClient } from '$lib/server/tmdb';
import { processMediaRefreshBatch } from '$lib/server/media/refresh-consumer';
import type { MediaRefreshMessage } from '$lib/server/media/refresh-consumer';
import type { QueueEnvelope, QueueOutcome } from '$lib/server/queue/types';
import { isAuthorizedCronRequest } from '$lib/server/http/secret';
import type { RequestHandler } from './$types';

interface Body {
	messages: QueueEnvelope<MediaRefreshMessage>[];
}

/**
 * Processes one Cloudflare Queues batch of media-refresh messages. Not reachable by end users —
 * self-`fetch`ed by the `queue()` handler appended to the worker (see `scripts/append-cron.mjs`),
 * the same way the `scheduled` handler self-fetches the other cron routes, since the
 * adapter-generated worker has no build step of its own that could import this route's module
 * graph directly. `queue()` can't get the ack/retry decision any other way: applying it requires
 * the real `Message` objects it holds, which only exist inside that invocation, so this route
 * computes the `QueueOutcome[]` and lets the caller relay it.
 *
 * Gated by `CRON_SECRET` like the other cron-triggered routes, purely so it isn't a bare unauth'd
 * TMDB-hydration endpoint — nothing about it is safe to expose otherwise.
 */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	if (!(await isAuthorizedCronRequest(request, platform?.env.CRON_SECRET))) {
		error(401, 'Unauthorized');
	}
	if (!locals.db) error(503, 'Service unavailable');
	if (!platform?.env.TMDB_API_KEY) error(503, 'Service unavailable');

	const { messages } = (await request.json()) as Body;
	const outcomes: QueueOutcome[] = await processMediaRefreshBatch(
		locals.db,
		createTmdbClient(platform.env.TMDB_API_KEY),
		messages,
		Date.now()
	);

	return json({ outcomes });
};
