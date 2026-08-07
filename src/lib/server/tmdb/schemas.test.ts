import { describe, expect, it } from 'vitest';
import {
	movieDetailsResponseSchema,
	multiSearchResponseSchema,
	seasonDetailResponseSchema
} from './schemas';

describe('TMDB response schemas', () => {
	it('accepts a realistic search response and keeps unknown fields', () => {
		const parsed = multiSearchResponseSchema.parse({
			page: 1,
			results: [{ id: 603, media_type: 'movie', title: 'The Matrix', brand_new_field: 'x' }],
			total_pages: 1
		});
		// Lenient by design: a field TMDB adds tomorrow must not fail today's client.
		expect(parsed.results?.[0]).toMatchObject({ id: 603, brand_new_field: 'x' });
	});

	it('accepts a search response with no results key', () => {
		expect(multiSearchResponseSchema.safeParse({ page: 1 }).success).toBe(true);
	});

	it('rejects an error envelope in place of a search response', () => {
		// What TMDB actually returns on a bad key.
		const parsed = multiSearchResponseSchema.safeParse({
			success: false,
			status_code: 7,
			status_message: 'Invalid API key'
		});
		expect(parsed.success).toBe(true); // no `results` is legal…
		expect(parsed.success && parsed.data.results).toBeUndefined();
	});

	it('rejects a results array whose entries are not items', () => {
		expect(multiSearchResponseSchema.safeParse({ results: ['nope'] }).success).toBe(false);
		expect(multiSearchResponseSchema.safeParse({ results: [{}] }).success).toBe(false);
	});

	it('requires a numeric id on details', () => {
		expect(movieDetailsResponseSchema.safeParse({ id: 603 }).success).toBe(true);
		expect(movieDetailsResponseSchema.safeParse({ id: '603' }).success).toBe(false);
		expect(movieDetailsResponseSchema.safeParse({}).success).toBe(false);
	});

	it('requires season_number and well-formed episodes', () => {
		expect(
			seasonDetailResponseSchema.safeParse({
				season_number: 1,
				episodes: [{ episode_number: 1, name: 'Pilot' }]
			}).success
		).toBe(true);
		expect(seasonDetailResponseSchema.safeParse({ name: 'S1' }).success).toBe(false);
		expect(
			seasonDetailResponseSchema.safeParse({ season_number: 1, episodes: [{ name: 'no number' }] })
				.success
		).toBe(false);
	});

	it('rejects a non-object payload', () => {
		expect(multiSearchResponseSchema.safeParse('<html>error</html>').success).toBe(false);
		expect(seasonDetailResponseSchema.safeParse(null).success).toBe(false);
	});
});
