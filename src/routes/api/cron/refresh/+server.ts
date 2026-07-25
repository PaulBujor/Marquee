import { error, json } from '@sveltejs/kit';
import { createTmdbClient } from '$lib/server/tmdb';
import { refreshStaleMedia } from '$lib/server/media/cron';
import { purgeExpiredAuth } from '$lib/server/auth/cleanup';
import type { RequestHandler } from './$types';

/**
 * The nightly media-refresh sweep. The cron `scheduled` handler self-`fetch`es this route (see
 * scripts/append-cron.mjs); it's HTTP-reachable and gated by `CRON_SECRET`, so it also doubles as a
 * manual trigger — `POST` it with an `x-cron-key: <CRON_SECRET>` header to force a refresh.
 */
export const POST: RequestHandler = async ({ request, url, locals, platform }) => {
	const secret = platform?.env.CRON_SECRET;
	if (!secret || request.headers.get('x-cron-key') !== secret) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');
	const apiKey = platform?.env.TMDB_API_KEY;
	if (!apiKey) error(503, 'TMDB is not configured.');

	// `?force=1` bypasses the per-row TTL — a manual re-hydrate (also useful for diagnostics).
	const force = url.searchParams.get('force') === '1';
	const result = await refreshStaleMedia(locals.db, createTmdbClient(apiKey), Date.now(), force);
	console.log(
		`cron: scanned ${result.scanned} unsettled titles — ${result.changed} changed, ${result.failed} failed${force ? ' (forced)' : ''}`
	);

	// Piggyback the auth-hygiene sweep on the same nightly run (MRQ-97): drop expired/consumed
	// login tokens and expired sessions so those tables don't grow unbounded.
	const purged = await purgeExpiredAuth(locals.db, Date.now());
	console.log(
		`cron: purged ${purged.loginTokens} stale login tokens and ${purged.sessions} expired sessions`
	);

	return json({ ...result, purged });
};
