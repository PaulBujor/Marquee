import { error, json } from '@sveltejs/kit';
import { createTmdbClient } from '$lib/server/tmdb';
import { refreshStaleMedia } from '$lib/server/media/cron';
import { purgeExpiredAuth } from '$lib/server/auth/cleanup';
import type { createDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

type Db = ReturnType<typeof createDb>;

/** Re-hydrate stale in-production media from TMDB. Self-contained: catches its own failures so a
 * TMDB outage (or missing key) can't prevent the other maintenance jobs from running. */
async function refreshMedia(db: Db, apiKey: string | undefined, force: boolean) {
	if (!apiKey) return { ok: false as const, error: 'TMDB is not configured.' };
	try {
		const result = await refreshStaleMedia(db, createTmdbClient(apiKey), Date.now(), force);
		console.log(
			`cron: ${result.scanned} unsettled titles, refreshed ${result.attempted} — ` +
				`${result.changed} changed, ${result.failed} failed` +
				`${result.capped ? ' (capped; remainder rolls to the next run)' : ''}${force ? ' (forced)' : ''}`
		);
		return { ok: true as const, ...result };
	} catch (err) {
		console.error('cron: media refresh failed', err);
		return { ok: false as const, error: 'media refresh failed' };
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
	const secret = platform?.env.CRON_SECRET;
	if (!secret || request.headers.get('x-cron-key') !== secret) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');

	// `?force=1` bypasses the per-row TTL — a manual re-hydrate (also useful for diagnostics).
	const force = url.searchParams.get('force') === '1';

	const media = await refreshMedia(locals.db, platform?.env.TMDB_API_KEY, force);
	const auth = await purgeAuth(locals.db);

	return json({ media, auth });
};
