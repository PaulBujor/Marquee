import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { createApiToken } from '#lib/server/api/auth.js';
import { API_TOKEN_LABEL_MAX, listApiTokens, toApiTokenSummary } from '#lib/server/api/tokens.js';
import { problem, zodProblem } from '#lib/server/http/problem.js';
import type { RequestHandler } from './$types';

const createTokenSchema = z.object({
	label: z.string().trim().min(1).max(API_TOKEN_LABEL_MAX)
});

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');

	return json({ tokens: await listApiTokens(locals.db, locals.user.id) });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');

	const raw: unknown = await request.json().catch(() => undefined);
	if (raw === undefined)
		return problem(400, 'Malformed request body', { detail: 'Body must be valid JSON.' });
	const parsed = createTokenSchema.safeParse(raw);
	if (!parsed.success) return zodProblem(parsed.error);

	const { token, row } = await createApiToken(locals.db, locals.user.id, parsed.data.label);
	// The plaintext is returned once and never stored; the caller must save it now.
	return json({ token, ...toApiTokenSummary(row) }, { status: 201 });
};
