/**
 * Standalone Cloudflare Worker for the nightly media-refresh cron (MRQ-39). It shares the app's
 * server library (`src/lib/server/*`) but is deployed separately via `wrangler.cron.jsonc`, because
 * `@sveltejs/adapter-cloudflare` emits a fetch-only worker and rewrites it on every build — there's
 * no slot for a `scheduled` handler in the app worker. Bound to the same D1 (`DB`) as the app.
 */
import { createDb } from '$lib/server/db';
import { createTmdbClient } from '$lib/server/tmdb';
import { refreshStaleShows } from '$lib/server/media/cron';

/** Bindings this Worker reads — the shared D1 + the TMDB key (set via `wrangler secret put`). */
interface CronEnv {
	DB: D1Database;
	TMDB_API_KEY: string;
}

async function run(env: CronEnv): Promise<void> {
	if (!env.TMDB_API_KEY) {
		console.error('cron: TMDB_API_KEY is not set — skipping refresh sweep');
		return;
	}
	const db = createDb(env.DB);
	const tmdb = createTmdbClient(env.TMDB_API_KEY);
	const result = await refreshStaleShows(db, tmdb);
	console.log(
		`cron: refreshed ${result.refreshed}/${result.scanned} in-production shows (${result.changed} changed)`
	);
}

export default {
	async scheduled(_controller: ScheduledController, env: CronEnv, ctx: ExecutionContext) {
		// Hold the invocation open until the sweep finishes (it outlives the handler return).
		ctx.waitUntil(run(env));
	}
};
