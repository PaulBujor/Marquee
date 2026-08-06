import { error, json } from '@sveltejs/kit';
import { problem, zodProblem } from '$lib/server/http/problem';
import { slidingWindow } from '$lib/server/http/rate-limit';
import { pushSubscribeSchema, upsertSubscription } from '$lib/server/push/subscriptions';
import type { RequestHandler } from './$types';

// Best-effort per-isolate cap on a runaway client (Cloudflare's edge limiter is the real backstop).
// Subscribing is rare; this only trips a loop.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;
const hits = new Map<string, number[]>();

/**
 * Store the caller's Web Push subscription (auth-gated). Idempotent — re-subscribing from the same
 * device updates the existing row (see `upsertSubscription`). The server re-validates the body.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');

	const { result, kept } = slidingWindow(
		hits.get(locals.user.id) ?? [],
		Date.now(),
		RATE_WINDOW_MS,
		RATE_MAX
	);
	// Drop the key once its window is empty, so the map doesn't retain an entry per user that has
	// ever hit this isolate.
	if (kept.length === 0) hits.delete(locals.user.id);
	else hits.set(locals.user.id, kept);
	if (result.limited)
		return new Response(null, {
			status: 429,
			headers: { 'Retry-After': String(result.retryAfterSec) }
		});

	const raw: unknown = await request.json().catch(() => undefined);
	if (raw === undefined)
		return problem(400, 'Malformed request body', { detail: 'Body must be valid JSON.' });
	const parsed = pushSubscribeSchema.safeParse(raw);
	if (!parsed.success) return zodProblem(parsed.error);

	await upsertSubscription(locals.db, locals.user.id, parsed.data);
	return json({ ok: true }, { status: 201 });
};
