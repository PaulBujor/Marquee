import { env } from '#lib/server/bindings.js';
import { error, json } from '@sveltejs/kit';
import { enqueueStaleMedia } from '#lib/server/media/cron.js';
import type { MediaRefreshMessage } from '#lib/server/media/refresh-consumer.js';
import { cloudflareQueueProducer } from '#lib/server/queue/cloudflare.js';
import type { QueueProducer } from '#lib/server/queue/types.js';
import { purgeExpiredAuth } from '#lib/server/auth/cleanup.js';
import { purgeSharePreviewWarms, purgeSharePreviews } from '#lib/server/share/preview.js';
import type { createDb } from '#lib/server/db/index.js';
import { isAuthorizedCronRequest } from '#lib/server/http/secret.js';
import type { RequestHandler } from './$types';

type Db = ReturnType<typeof createDb>;

/** Self-contained: a D1/queue outage here must not stop the other maintenance jobs. */
async function enqueueMedia(db: Db, queue: QueueProducer<MediaRefreshMessage>, force: boolean) {
	try {
		const result = await enqueueStaleMedia(db, queue, Date.now(), force);
		console.log(
			`cron: ${result.scanned} unsettled titles, enqueued ${result.queued}` +
				`${result.capped ? ' (capped; remainder rolls to the next run)' : ''}${force ? ' (forced)' : ''}`
		);
		return { ok: true as const, ...result };
	} catch (err) {
		console.error('cron: media enqueue failed', err);
		return { ok: false as const, error: 'media enqueue failed' };
	}
}

async function purgeAuth(db: Db) {
	try {
		const purged = await purgeExpiredAuth(db, Date.now());
		console.log(
			`cron: purged ${purged.loginTokens} stale login tokens, ${purged.sessions} expired sessions ` +
				`and ${purged.notifications} old notification-log rows`
		);
		return { ok: true as const, ...purged };
	} catch (err) {
		console.error('cron: auth purge failed', err);
		return { ok: false as const, error: 'auth purge failed' };
	}
}

async function purgeShareData(db: Db) {
	try {
		const warms = await purgeSharePreviewWarms(db, Date.now());
		const previews = await purgeSharePreviews(db, Date.now());
		console.log(
			`cron: purged ${warms} stale share-preview warm rows and ${previews} expired previews`
		);
		return { ok: true as const, purged: { warms, previews } };
	} catch (err) {
		console.error('cron: share-preview purge failed', err);
		return { ok: false as const, error: 'share purge failed' };
	}
}

/** Self-`fetch`ed by the cron `scheduled` handler (see scripts/append-cron.mjs); `x-cron-key: <CRON_SECRET>` also runs it on demand. */
export const POST: RequestHandler = async ({ request, url, locals }) => {
	if (!(await isAuthorizedCronRequest(request, env.CRON_SECRET))) {
		error(401, 'Unauthorized');
	}
	if (!locals.db) error(503, 'Service unavailable');

	// `?force=1` bypasses the per-row TTL — a manual re-hydrate (also useful for diagnostics).
	const force = url.searchParams.get('force') === '1';

	// Without a key every message 503s, the relay retries the batch and the backlog dead-letters — so check once here.
	const tmdbKey = env.TMDB_API_KEY;
	if (!tmdbKey) console.error('cron: skipping media enqueue — TMDB is not configured.');
	const media = tmdbKey
		? await enqueueMedia(locals.db, cloudflareQueueProducer(env.MEDIA_REFRESH_QUEUE), force)
		: { ok: false as const, error: 'TMDB is not configured.' };
	const auth = await purgeAuth(locals.db);
	const share = await purgeShareData(locals.db);

	return json({ media, auth, share });
};
