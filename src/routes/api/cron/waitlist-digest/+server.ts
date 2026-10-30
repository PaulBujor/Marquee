import { env } from '#lib/server/bindings.js';
import { error, json } from '@sveltejs/kit';
import { sendWaitlistDigest } from '#lib/server/admin/waitlist-digest.js';
import { isAuthorizedCronRequest } from '#lib/server/http/secret.js';
import type { RequestHandler } from './$types';

/** Self-fetched by the cron `scheduled` handler (see scripts/append-cron.mjs); `x-cron-key: <CRON_SECRET>` also runs it on demand. */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!(await isAuthorizedCronRequest(request, env.CRON_SECRET))) {
		error(401, 'Unauthorized');
	}
	if (!locals.db) error(503, 'Service unavailable');

	try {
		const result = await sendWaitlistDigest(locals.db, env);
		console.log(
			`cron: waitlist digest — ${result.pending} waiting, ${result.sent} sent, ${result.skipped} skipped`
		);
		return json({ ok: true, ...result });
	} catch (err) {
		console.error('cron: waitlist digest failed', err);
		return json({ ok: false, error: 'waitlist digest failed' }, { status: 500 });
	}
};
