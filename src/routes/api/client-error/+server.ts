import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';

/**
 * The client-error sink: browser-side errors (uncaught client exceptions, sync failures)
 * POST here and are logged **structured** so Cloudflare observability (logs/traces, see
 * wrangler.jsonc) ingests them — the browser console alone never reaches any backend.
 *
 * Deliberately tolerant: a reporting endpoint must not itself be noisy. It logs and returns 200 for
 * a signed-in user, silently 204s an unauthenticated caller (so an open endpoint can't be used to
 * spam logs), and 400s only a malformed body. It never echoes anything sensitive back.
 */
const clientErrorSchema = z.object({
	message: z.string().min(1).max(2000),
	source: z.string().max(200).optional(),
	status: z.number().int().optional(),
	stack: z.string().max(8000).optional(),
	url: z.string().max(2000).optional(),
	at: z.number().optional()
});

export const POST: RequestHandler = async ({ request, locals }) => {
	// Unauthenticated reports are dropped without logging — bounds abuse of the open endpoint.
	if (!locals.user) return new Response(null, { status: 204 });

	const raw: unknown = await request.json().catch(() => undefined);
	const parsed = clientErrorSchema.safeParse(raw);
	if (!parsed.success) return json({ ok: false }, { status: 400 });

	const e = parsed.data;
	const id = crypto.randomUUID();
	console.error(
		`[client-error ${id}] user=${locals.user.id} source=${e.source ?? 'unknown'}` +
			`${e.status !== undefined ? ` status=${e.status}` : ''} ${e.message}`,
		{ url: e.url, stack: e.stack, at: e.at }
	);
	return json({ ok: true, id });
};
