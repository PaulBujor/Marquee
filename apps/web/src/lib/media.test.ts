import { describe, expect, it } from 'vitest';
import { hasDescription, posterUrl } from './media';

describe('posterUrl', () => {
	it('builds a sized TMDB image URL', () => {
		expect(posterUrl('/poster.jpg')).toBe('https://image.tmdb.org/t/p/w342/poster.jpg');
		expect(posterUrl('/poster.jpg', 'w500')).toBe('https://image.tmdb.org/t/p/w500/poster.jpg');
	});

	it('returns null when there is no poster path', () => {
		expect(posterUrl(null)).toBeNull();
	});
});

describe('hasDescription', () => {
	it('is false for an empty string — TMDB sends "" for a missing overview', () => {
		expect(hasDescription('')).toBe(false);
	});

	it('is false for a whitespace-only string', () => {
		expect(hasDescription('   ')).toBe(false);
	});

	it('is false for null / undefined', () => {
		expect(hasDescription(null)).toBe(false);
		expect(hasDescription(undefined)).toBe(false);
	});

	it('is true for a non-empty description', () => {
		expect(hasDescription('The beginning.')).toBe(true);
	});
});
