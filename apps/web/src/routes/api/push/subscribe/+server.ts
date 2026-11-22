import { error, json } from '@sveltejs/kit';
import { problem, zodProblem } from '#lib/server/http/problem.js';
import { slidingWindow } from '#lib/server/http/rate-limit.js';
import { pushSubscribeSchema, upsertSubscription } from '#lib/server/push/subscriptions.js';
import type { RequestHandler } from './$types';

// Best-effort per-isolate cap on a runaway client: Cloudflare's edge limiter is the real backstop.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;
const hits = new Map<string, number[]>();

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');

	const { result, kept } = slidingWindow(
		hits.get(locals.user.id) ?? [],
		Date.now(),
		RATE_WINDOW_MS,
		RATE_MAX
	);
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
