import { json } from '@sveltejs/kit';
import { env } from '#lib/server/bindings.js';
import { authenticateApiToken } from '#lib/server/api/auth.js';
import { problem, zodProblem } from '#lib/server/http/problem.js';
import {
	applyLibraryCommand,
	libraryCommandSchema,
	UnknownMediaError
} from '#lib/server/library/command.js';
import { readLibraryEntry } from '#lib/server/library/read.js';
import { resolveMediaIdOrHydrate, type ResolveMediaResult } from '#lib/server/media/resolve.js';
import { createTmdbClient, TmdbError } from '#lib/server/tmdb/index.js';
import type { RequestHandler } from './$types';

/** Our media ids are UUIDs; anything else in that position is an external id the resolver has to translate. */
const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Applies a partial command to one title and answers with the read model's entry, so a retried PATCH,
 * which is what at-least-once delivery produces, settles on the same state.
 */
export const PATCH: RequestHandler = async ({ request, locals, params }) => {
	if (!locals.db) return problem(503, 'Service unavailable');

	const identity = await authenticateApiToken(request, locals.db);
	if (!identity)
		return problem(401, 'Unauthorized', {
			detail: 'A valid bearer token is required.',
			headers: { 'www-authenticate': 'Bearer' }
		});

	const type = params.type;
	if (type !== 'movie' && type !== 'show')
		return problem(400, 'Invalid type', { detail: "type must be 'movie' or 'show'." });

	const raw: unknown = await request.json().catch(() => undefined);
	if (raw === undefined)
		return problem(400, 'Malformed request body', { detail: 'Body must be valid JSON.' });
	const parsed = libraryCommandSchema.safeParse(raw);
	if (!parsed.success) return zodProblem(parsed.error);
	// An empty command is a caller bug, not a change to accept and silently ignore.
	if (Object.keys(parsed.data).length === 0)
		return problem(400, 'Empty command', { detail: 'Name at least one field to change.' });

	let mediaId: string;
	if (MEDIA_ID.test(params.id)) {
		mediaId = params.id;
	} else {
		const apiKey = env.TMDB_API_KEY;
		if (!apiKey) return problem(503, 'Media is not configured');

		let resolved: ResolveMediaResult;
		try {
			resolved = await resolveMediaIdOrHydrate(locals.db, createTmdbClient(apiKey), {
				type,
				// A bare TMDB id is the numeric half of the `movie/603` form the resolver speaks.
				externalId: /^\d+$/.test(params.id) ? `${type}/${params.id}` : params.id
			});
		} catch (err) {
			if (err instanceof TmdbError)
				return problem(502, 'Upstream failure', {
					detail: 'The media provider could not be reached. Try again later.'
				});
			throw err;
		}
		if (!('mediaId' in resolved))
			return problem(422, 'Unresolved media', {
				detail: 'The id does not name a single title we can act on.'
			});
		mediaId = resolved.mediaId;
	}

	try {
		await applyLibraryCommand(locals.db, identity.userId, mediaId, parsed.data, {
			surface: 'api',
			apiTokenId: identity.tokenId
		});
	} catch (err) {
		// Another user's private entry answers exactly like one that does not exist.
		if (err instanceof UnknownMediaError)
			return problem(404, 'Not found', { detail: 'No such title in your library.' });
		throw err;
	}

	const entry = await readLibraryEntry(locals.db, identity.userId, mediaId);
	if (!entry) return problem(404, 'Not found', { detail: 'No such title in your library.' });
	return json(entry);
};
