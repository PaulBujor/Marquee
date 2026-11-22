import { env } from '#lib/server/bindings.js';
import { error, json } from '@sveltejs/kit';
import { createTmdbClient } from '#lib/server/tmdb/index.js';
import { processMediaRefreshBatch } from '#lib/server/media/refresh-consumer.js';
import type { MediaRefreshMessage } from '#lib/server/media/refresh-consumer.js';
import type { QueueEnvelope, QueueOutcome } from '#lib/server/queue/types.js';
import { isAuthorizedCronRequest } from '#lib/server/http/secret.js';
import type { RequestHandler } from './$types';

interface Body {
	messages: QueueEnvelope<MediaRefreshMessage>[];
}

/** Returns QueueOutcome[] rather than acking: only the self-fetching caller holds the real `Message` objects. */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!(await isAuthorizedCronRequest(request, env.CRON_SECRET))) {
		error(401, 'Unauthorized');
	}
	if (!locals.db) error(503, 'Service unavailable');
	if (!env.TMDB_API_KEY) error(503, 'Service unavailable');

	const { messages } = (await request.json()) as Body;
	const outcomes: QueueOutcome[] = await processMediaRefreshBatch(
		locals.db,
		createTmdbClient(env.TMDB_API_KEY),
		messages,
		Date.now()
	);

	return json({ outcomes });
};
