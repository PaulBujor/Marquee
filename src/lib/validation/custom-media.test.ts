import { describe, expect, it } from 'vitest';
import {
	CUSTOM_MAX_EPISODES_PER_SEASON,
	CUSTOM_MAX_EPISODES_TOTAL,
	CUSTOM_MAX_SEASONS,
	CUSTOM_TITLE_MAX,
	customMediaInputSchema,
	totalEpisodes
} from './custom-media';

function input(over: Record<string, unknown> = {}) {
	return { title: 'A Title', type: 'movie', year: 1986, overview: '', seasons: [], ...over };
}

const ok = (value: unknown) => customMediaInputSchema.safeParse(value).success;

describe('customMediaInputSchema', () => {
	it('accepts a minimal movie', () => {
		expect(ok(input())).toBe(true);
		expect(ok(input({ year: null, overview: '' }))).toBe(true);
	});

	it('accepts a show with seasons', () => {
		expect(
			ok(
				input({
					type: 'show',
					seasons: [
						{ seasonNumber: 1, episodeCount: 8 },
						{ seasonNumber: 2, episodeCount: 0 }
					]
				})
			)
		).toBe(true);
	});

	it('requires a title, after trimming', () => {
		expect(ok(input({ title: '' }))).toBe(false);
		expect(ok(input({ title: '   ' }))).toBe(false);
		expect(ok(input({ title: 'x'.repeat(CUSTOM_TITLE_MAX + 1) }))).toBe(false);
	});

	it('bounds the year to something a film could plausibly carry', () => {
		expect(ok(input({ year: 1500 }))).toBe(false);
		expect(ok(input({ year: 9999 }))).toBe(false);
		expect(ok(input({ year: 1.5 }))).toBe(false);
	});

	it('rejects seasons on a movie', () => {
		expect(ok(input({ seasons: [{ seasonNumber: 1, episodeCount: 1 }] }))).toBe(false);
	});

	it('rejects duplicate season numbers', () => {
		expect(
			ok(
				input({
					type: 'show',
					seasons: [
						{ seasonNumber: 1, episodeCount: 1 },
						{ seasonNumber: 1, episodeCount: 2 }
					]
				})
			)
		).toBe(false);
	});

	it('bounds seasons, episodes per season, and the total', () => {
		const seasons = (n: number, each: number) =>
			Array.from({ length: n }, (_, i) => ({ seasonNumber: i + 1, episodeCount: each }));

		expect(ok(input({ type: 'show', seasons: seasons(CUSTOM_MAX_SEASONS, 1) }))).toBe(true);
		expect(ok(input({ type: 'show', seasons: seasons(CUSTOM_MAX_SEASONS + 1, 1) }))).toBe(false);
		expect(
			ok(
				input({
					type: 'show',
					seasons: [{ seasonNumber: 1, episodeCount: CUSTOM_MAX_EPISODES_PER_SEASON + 1 }]
				})
			)
		).toBe(false);
		// Each season is individually within bounds, but the total is what actually needs limiting:
		// every episode becomes a row on both sides and an event apiece when the entry is linked.
		const overTotal = seasons(CUSTOM_MAX_SEASONS, CUSTOM_MAX_EPISODES_PER_SEASON);
		expect(totalEpisodes(overTotal)).toBeGreaterThan(CUSTOM_MAX_EPISODES_TOTAL);
		expect(ok(input({ type: 'show', seasons: overTotal }))).toBe(false);
	});

	it('rejects a season numbered 0 — Specials are a provider concept', () => {
		expect(ok(input({ type: 'show', seasons: [{ seasonNumber: 0, episodeCount: 1 }] }))).toBe(
			false
		);
	});
});

describe('totalEpisodes', () => {
	it('sums across seasons', () => {
		expect(totalEpisodes([])).toBe(0);
		expect(
			totalEpisodes([
				{ seasonNumber: 1, episodeCount: 8 },
				{ seasonNumber: 2, episodeCount: 6 }
			])
		).toBe(14);
	});
});
