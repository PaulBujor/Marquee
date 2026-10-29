import { env } from '#lib/server/bindings.js';
import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { problem, zodProblem } from '#lib/server/http/problem.js';
import { warmTitlePreview, type WarmResult } from '#lib/server/share/preview.js';
import { publicSharingEnabled } from '#lib/server/share/public.js';
import type { RequestHandler } from './$types';

/**
 * Warm the preview for a title a user is about to share, so the recipient's link renders a page
 * instead of waiting on a cold read. Authenticated on purpose: this is the only route in the share
 * flow that talks to TMDB, which is what keeps the public read path free of provider calls (and
 * provider quota) no matter who follows a link. Idempotent — re-warming refreshes the same row.
 */
const bodySchema = z.object({
	type: z.enum(['movie', 'show']),
	id: z.number().int().positive()
});

/** Status codes the client can act on: a missing title is not an error worth surfacing. */
const STATUS: Record<WarmResult['kind'], number> = {
	warmed: 200,
	rate_limited: 429,
	not_found: 404,
	unavailable: 503
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');

	const raw: unknown = await request.json().catch(() => undefined);
	if (raw === undefined)
		return problem(400, 'Malformed request body', { detail: 'Body must be valid JSON.' });

	const parsed = bodySchema.safeParse(raw);
	if (!parsed.success) return zodProblem(parsed.error);

	const apiKey = env.TMDB_API_KEY;
	if (!apiKey) error(503, 'Shared links are not configured.');
	// The kill switch has to cover the writes too, or previews accumulate for a surface that's off.
	if (!publicSharingEnabled(env)) error(503, 'Shared links are not configured.');

	const userId = locals.user.id;
	let result: WarmResult;
	try {
		result = await warmTitlePreview(locals.db, apiKey, {
			userId,
			type: parsed.data.type,
			id: parsed.data.id
		});
	} catch (err) {
		// Log the cause: D1's own message names the column or constraint, the wrapper's stack doesn't.
		const wrapped = err as { message?: string; cause?: unknown };
		console.error('share preview: warm failed', wrapped?.message, String(wrapped?.cause ?? ''));
		error(500, 'Could not store the preview.');
	}

	return json({ status: result.kind }, { status: STATUS[result.kind] });
};
