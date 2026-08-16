/**
 * Runtime shape checks for TMDB responses.
 *
 * TMDB is the app's only untrusted external data source, and it was the one trust boundary in the
 * codebase without runtime validation — every other boundary (`eventEnvelopeSchema`,
 * `mediaSyncRequestSchema`, `pushSubscribeSchema`, the export `documentSchema`) parses before use.
 * That matters here because TMDB data flows straight into the shared `media`/`seasons`/`episodes`
 * tables and from there to every client: a shape change surfaces far downstream as `undefined`
 * where a value was expected, rather than as a clean rejection at the edge.
 *
 * Deliberately **lenient**. These are not a mirror of TMDB's full API — only the fields the client
 * actually reads are required, everything else passes through untouched, and optional fields stay
 * optional. The goal is to catch "this isn't the response we think it is" (an error envelope, an
 * HTML error page parsed as JSON, a renamed container), not to reject a payload for carrying a new
 * field. `normalizeDetails` already defends field-by-field with `?? null` / `?? ''`; what was
 * missing was any check on the container itself.
 */
import { z } from 'zod';

/** Every schema is `loose` so unknown keys survive — see the module note on leniency. */
const multiSearchItem = z.looseObject({
	id: z.number(),
	media_type: z.string().optional()
});

export const multiSearchResponseSchema = z.looseObject({
	results: z.array(multiSearchItem).optional()
});

const detailsBase = {
	id: z.number()
};

export const movieDetailsResponseSchema = z.looseObject(detailsBase);
export const tvDetailsResponseSchema = z.looseObject(detailsBase);

export const personResponseSchema = z.looseObject(detailsBase);

export const seasonDetailResponseSchema = z.looseObject({
	season_number: z.number(),
	episodes: z
		.array(
			z.looseObject({
				episode_number: z.number()
			})
		)
		.optional()
});
