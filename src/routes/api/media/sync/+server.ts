import { env } from '#lib/server/bindings.js';
import { error, json } from '@sveltejs/kit';
import { createTmdbClient } from '#lib/server/tmdb/index.js';
import { resolveMediaSync } from '#lib/server/media/sync.js';
import { mediaSyncRequestSchema } from '#lib/sync/media-protocol.js';
import { problem, zodProblem } from '#lib/server/http/problem.js';
import type { RequestHandler } from './$types';

/**
 * The media reference channel — separate from `/api/sync` (events), since media is heavier.
 * The client sends identity only; the server derives our id and hydrates from TMDB, so shared
 * `linked` rows can't be poisoned with client-supplied metadata. Auth-gated.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!locals.db) error(503, 'Service unavailable');
	const apiKey = env.TMDB_API_KEY;
	if (!apiKey) error(503, 'Media is not configured.');

	const raw: unknown = await request.json().catch(() => undefined);
	if (raw === undefined)
		return problem(400, 'Malformed request body', { detail: 'Body must be valid JSON.' });
	const parsed = mediaSyncRequestSchema.safeParse(raw);
	if (!parsed.success) return zodProblem(parsed.error);

	const tmdb = createTmdbClient(apiKey);
	const response = await resolveMediaSync(locals.db, tmdb, locals.user.id, parsed.data);
	return json(response);
};
