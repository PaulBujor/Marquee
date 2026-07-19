import { describe, expect, it } from 'vitest';
import { posterUrl } from './media';

describe('posterUrl', () => {
	it('builds a sized TMDB image URL', () => {
		expect(posterUrl('/poster.jpg')).toBe('https://image.tmdb.org/t/p/w342/poster.jpg');
		expect(posterUrl('/poster.jpg', 'w500')).toBe('https://image.tmdb.org/t/p/w500/poster.jpg');
	});

	it('returns null when there is no poster path', () => {
		expect(posterUrl(null)).toBeNull();
	});
});
