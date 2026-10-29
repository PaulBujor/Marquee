import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';

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
