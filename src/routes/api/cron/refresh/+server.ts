import { error, json } from '@sveltejs/kit';
import { enqueueStaleMedia } from '$lib/server/media/cron';
import type { MediaRefreshMessage } from '$lib/server/media/refresh-consumer';
import { cloudflareQueueProducer } from '$lib/server/queue/cloudflare';
import type { QueueProducer } from '$lib/server/queue/types';
import { purgeExpiredAuth } from '$lib/server/auth/cleanup';
import type { createDb } from '$lib/server/db';
import { isAuthorizedCronRequest } from '$lib/server/http/secret';
import type { RequestHandler } from './$types';

type Db = ReturnType<typeof createDb>;

/** Enqueue stale in-production media for re-hydration by the media-refresh queue consumer.
 * Self-contained: catches its own failures so a D1/queue outage can't prevent the other
 * maintenance jobs from running. */
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

/** Drop expired/consumed login tokens and expired sessions so those tables don't grow unbounded.
 * Self-contained: catches its own failures so it can't trip the other jobs. */
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

/**
 * The daily maintenance sweep (media refresh + auth-token/session purge). The cron `scheduled`
 * handler self-`fetch`es this route for the `0 6 * * *` trigger (see scripts/append-cron.mjs); it's
 * HTTP-reachable and gated by `CRON_SECRET`, so it also doubles as a manual trigger — `POST` it with
 * an `x-cron-key: <CRON_SECRET>` header to run it on demand. The notifications digest is on its own
 * hourly schedule (see `/api/cron/notify`). Each job isolates its own errors so one failing never
 * prevents the others.
 */
export const POST: RequestHandler = async ({ request, url, locals, platform }) => {
	if (!(await isAuthorizedCronRequest(request, platform?.env.CRON_SECRET))) {
		error(401, 'Unauthorized');
	}
	if (!locals.db) error(503, 'Service unavailable');

	// `?force=1` bypasses the per-row TTL — a manual re-hydrate (also useful for diagnostics).
	const force = url.searchParams.get('force') === '1';

	// `platform` is always set alongside `locals.db` (see hooks.server.ts) — the guard above covers
	// both.
	// Enqueueing itself never calls TMDB, but every message it produces will: without a key the
	// consumer 503s on each batch, the relay retries the whole batch, and the entire backlog
	// dead-letters. Check once here instead, and no-op the way the synchronous sweep used to.
	const tmdbKey = platform!.env.TMDB_API_KEY;
	if (!tmdbKey) console.error('cron: skipping media enqueue — TMDB is not configured.');
	const media = tmdbKey
		? await enqueueMedia(
				locals.db,
				cloudflareQueueProducer(platform!.env.MEDIA_REFRESH_QUEUE),
				force
			)
		: { ok: false as const, error: 'TMDB is not configured.' };
	const auth = await purgeAuth(locals.db);

	return json({ media, auth });
};
