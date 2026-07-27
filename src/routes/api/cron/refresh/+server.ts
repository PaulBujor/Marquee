import { error, json } from '@sveltejs/kit';
import { createTmdbClient } from '$lib/server/tmdb';
import { refreshStaleMedia } from '$lib/server/media/cron';
import { purgeExpiredAuth } from '$lib/server/auth/cleanup';
import { sendNewReleaseDigest } from '$lib/server/push/digest';
import type { createDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

type Db = ReturnType<typeof createDb>;

/** UTC hour the once-a-day maintenance jobs run at. The cron fires hourly (for 9AM-local pushes),
 *  so these are gated to one hour rather than running 24×/day. */
const DAILY_UTC_HOUR = 6;

/** Re-hydrate stale in-production media from TMDB. Self-contained: catches its own failures so a
 * TMDB outage (or missing key) can't prevent the other maintenance jobs from running. */
async function refreshMedia(db: Db, apiKey: string | undefined, force: boolean) {
	if (!apiKey) return { ok: false as const, error: 'TMDB is not configured.' };
	try {
		const result = await refreshStaleMedia(db, createTmdbClient(apiKey), Date.now(), force);
		console.log(
			`cron: scanned ${result.scanned} unsettled titles — ${result.changed} changed, ${result.failed} failed${force ? ' (forced)' : ''}`
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
			`cron: purged ${purged.loginTokens} stale login tokens and ${purged.sessions} expired sessions`
		);
		return { ok: true as const, ...purged };
	} catch (err) {
		console.error('cron: auth purge failed', err);
		return { ok: false as const, error: 'auth purge failed' };
	}
}

/** Send the daily new-release push digest to users for whom it's ~9AM local. Self-contained: catches
 * its own failures (incl. an unconfigured VAPID key) so it can't trip the maintenance jobs. */
async function sendDigests(db: Db, env: Env | undefined, now: Date) {
	if (!env) return { ok: false as const, error: 'platform env unavailable' };
	try {
		const result = await sendNewReleaseDigest(db, env, now);
		console.log(
			`cron: notifications — ${result.dueUsers} due user(s), ${result.sent} sent, ${result.pruned} pruned`
		);
		return { ok: true as const, ...result };
	} catch (err) {
		console.error('cron: notifications failed', err);
		return { ok: false as const, error: 'notifications failed' };
	}
}

/**
 * The maintenance + notifications sweep. The cron `scheduled` handler self-`fetch`es this route (see
 * scripts/append-cron.mjs); it's HTTP-reachable and gated by `CRON_SECRET`, so it also doubles as a
 * manual trigger — `POST` it with an `x-cron-key: <CRON_SECRET>` header to run it on demand.
 *
 * The cron fires **hourly** so the push digest can go out at 9AM in each user's timezone. The
 * once-a-day jobs (media refresh, auth purge) are gated to `DAILY_UTC_HOUR` so they still run once
 * daily; the notifications job runs every hour and decides per-user by local time. Each job isolates
 * its own errors so one failing never prevents the others.
 */
export const POST: RequestHandler = async ({ request, url, locals, platform }) => {
	const secret = platform?.env.CRON_SECRET;
	if (!secret || request.headers.get('x-cron-key') !== secret) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');

	// `?force=1` bypasses the per-row TTL and the daily-hour gate — a manual run (also for diagnostics).
	const force = url.searchParams.get('force') === '1';
	const daily = force || new Date().getUTCHours() === DAILY_UTC_HOUR;

	const media = daily
		? await refreshMedia(locals.db, platform?.env.TMDB_API_KEY, force)
		: { skipped: true as const };
	const auth = daily ? await purgeAuth(locals.db) : { skipped: true as const };
	const notifications = await sendDigests(locals.db, platform?.env, new Date());

	return json({ media, auth, notifications });
};
