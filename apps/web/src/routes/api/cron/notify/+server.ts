import { env } from '#lib/server/bindings.js';
import { error, json } from '@sveltejs/kit';
import { sendNewReleaseDigest } from '#lib/server/push/digest.js';
import type { createDb } from '#lib/server/db/index.js';
import { isAuthorizedCronRequest } from '#lib/server/http/secret.js';
import type { RequestHandler } from './$types';

type Db = ReturnType<typeof createDb>;

/** Swallows its own failures (incl. an unconfigured VAPID key) so a bad run just no-ops. */
async function sendDigests(db: Db, env: Env, now: Date) {
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

/** Hourly so ~9AM local lands in every timezone; `x-cron-key: <CRON_SECRET>` also runs it on demand. */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!(await isAuthorizedCronRequest(request, env.CRON_SECRET))) {
		error(401, 'Unauthorized');
	}
	if (!locals.db) error(503, 'Service unavailable');

	const notifications = await sendDigests(locals.db, env, new Date());

	return json({ notifications });
};
