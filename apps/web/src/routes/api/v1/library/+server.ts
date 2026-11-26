import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '#lib/server/bindings.js';
import { authenticateApiToken } from '#lib/server/api/auth.js';
import { problem, zodProblem } from '#lib/server/http/problem.js';
import {
	applyLibraryCommand,
	libraryCommandSchema,
	UnknownMediaError
} from '#lib/server/library/command.js';
import {
	InvalidLibraryCursorError,
	LIBRARY_PAGE_MAX,
	readLibraryPage
} from '#lib/server/library/read.js';
import { resolveTargetMediaId, type TargetMediaResult } from '#lib/server/media/resolve.js';
import { TmdbError } from '#lib/server/tmdb/index.js';
import type { RequestHandler } from './$types';

/** Ceiling on one batch, because a truncated import that reports success is worse than a refused one. */
export const LIBRARY_BATCH_MAX = 500;

/** A batch item is a title plus the same command the single-title PATCH takes. */
const batchItemSchema = libraryCommandSchema.extend({
	type: z.enum(['movie', 'show']),
	id: z.string().min(1)
});

type BatchItem = z.infer<typeof batchItemSchema>;

/** Strict items carry only known keys, so anything past `type` and `id` is a field to change. */
const hasCommand = (item: BatchItem): boolean => Object.keys(item).length > 2;

const libraryBatchSchema = z
	.object({
		items: z
			.array(batchItemSchema.refine(hasCommand, { message: 'Name at least one field to change.' }))
			.min(1)
			.max(LIBRARY_BATCH_MAX)
	})
	.strict();

export type LibraryBatchFailureCode = 'unresolved' | 'not_found' | 'upstream_unavailable';

export interface LibraryBatchResult {
	applied: number;
	unchanged: number;
	/** Per-title failures; each carries the id the caller sent, so it can retry exactly those. */
	failed: { id: string; code: LibraryBatchFailureCode; reason: string }[];
}

/**
 * Applies many commands in one request, so a first import is not one round trip per title. A title that
 * can't be applied is reported in `failed` while its siblings still apply — the caller needs them.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.db) return problem(503, 'Service unavailable');

	const identity = await authenticateApiToken(request, locals.db);
	if (!identity)
		return problem(401, 'Unauthorized', {
			detail: 'A valid bearer token is required.',
			headers: { 'www-authenticate': 'Bearer' }
		});

	const raw: unknown = await request.json().catch(() => undefined);
	if (raw === undefined)
		return problem(400, 'Malformed request body', { detail: 'Body must be valid JSON.' });
	const parsed = libraryBatchSchema.safeParse(raw);
	if (!parsed.success) return zodProblem(parsed.error);

	const result: LibraryBatchResult = { applied: 0, unchanged: 0, failed: [] };
	const fail = (id: string, code: LibraryBatchFailureCode, reason: string): void => {
		result.failed.push({ id, code, reason });
	};

	// Sequential on purpose: a rate limit is ours to respect, and the batch is bounded.
	// shortcut: sequential, so a full batch is slow; chunk on the client before raising the cap.
	for (const { type, id, ...command } of parsed.data.items) {
		let target: TargetMediaResult;
		try {
			target = await resolveTargetMediaId(locals.db, env.TMDB_API_KEY, { type, id });
		} catch (err) {
			if (!(err instanceof TmdbError)) throw err;
			fail(id, 'upstream_unavailable', 'The media provider failed for this id. Retry it later.');
			continue;
		}

		if ('unavailable' in target) {
			fail(id, 'upstream_unavailable', 'The media provider is not configured on this server.');
			continue;
		}
		if ('unresolved' in target) {
			fail(id, 'unresolved', 'The id does not name a single title we can act on.');
			continue;
		}

		try {
			const events = await applyLibraryCommand(
				locals.db,
				identity.userId,
				target.mediaId,
				command,
				{ surface: 'api', apiTokenId: identity.tokenId }
			);
			if (events.length === 0) result.unchanged++;
			else result.applied++;
		} catch (err) {
			// Another user's private entry answers exactly like one that does not exist.
			if (!(err instanceof UnknownMediaError)) throw err;
			fail(id, 'not_found', 'No such title in your library.');
		}
	}

	return json(result);
};

/** A page of the caller's library. The token is the only source of the user id. */
export const GET: RequestHandler = async ({ request, locals, url }) => {
	if (!locals.db) return problem(503, 'Service unavailable');

	const identity = await authenticateApiToken(request, locals.db);
	if (!identity)
		return problem(401, 'Unauthorized', {
			detail: 'A valid bearer token is required.',
			headers: { 'www-authenticate': 'Bearer' }
		});

	const rawLimit = url.searchParams.get('limit');
	const limit = rawLimit === null ? undefined : Number(rawLimit);
	if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= LIBRARY_PAGE_MAX))
		return problem(400, 'Invalid query parameters', {
			detail: `limit must be an integer from 1 to ${LIBRARY_PAGE_MAX}.`
		});

	try {
		return json(
			await readLibraryPage(locals.db, identity.userId, {
				limit,
				cursor: url.searchParams.get('cursor')
			})
		);
	} catch (err) {
		if (err instanceof InvalidLibraryCursorError)
			return problem(400, 'Invalid cursor', {
				type: 'invalid_cursor',
				detail: 'The cursor is not one this endpoint issued.'
			});
		throw err;
	}
};
