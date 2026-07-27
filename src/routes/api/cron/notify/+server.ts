import { error, json } from '@sveltejs/kit';
import { sendNewReleaseDigest } from '$lib/server/push/digest';
import type { createDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

type Db = ReturnType<typeof createDb>;

/** Send the new-release push digest to users for whom it's ~9AM local. Self-contained: catches its
 * own failures (incl. an unconfigured VAPID key) so a bad run just no-ops. */
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
 * The hourly notifications job: sends the new-release digest to users for whom it's currently ~9AM
 * local (see `sendNewReleaseDigest`). Fired every hour by the `0 * * * *` cron so 9AM lands in every
 * timezone (see scripts/append-cron.mjs); gated by `CRON_SECRET`, so a `POST` with an
 * `x-cron-key: <CRON_SECRET>` header also runs it on demand.
 */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const secret = platform?.env.CRON_SECRET;
	if (!secret || request.headers.get('x-cron-key') !== secret) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');

	const notifications = await sendDigests(locals.db, platform?.env, new Date());

	return json({ notifications });
};
