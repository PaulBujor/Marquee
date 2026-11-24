/** Deliberately lenient: catches "this isn't the response we think it is", not a payload carrying a new field. */
import { z } from 'zod';

/** Every schema is `loose` so unknown keys survive. */
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

/** `/movie|tv/{id}/external_ids` — the same block `getDetails` appends, fetched on its own. */
export const externalIdsResponseSchema = z.looseObject({
	...detailsBase,
	imdb_id: z.string().nullish()
});

/** `/find/{id}` — one id's results, split by media type. Only the ids are read; a details payload is the caller's next step. */
export const findResponseSchema = z.looseObject({
	movie_results: z.array(z.looseObject({ id: z.number() })).optional(),
	tv_results: z.array(z.looseObject({ id: z.number() })).optional()
});

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
