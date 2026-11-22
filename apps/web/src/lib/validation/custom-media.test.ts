import { describe, expect, it } from 'vitest';
import {
	CUSTOM_MAX_CREDITS,
	CUSTOM_MAX_EPISODES_PER_SEASON,
	CUSTOM_MAX_EPISODES_TOTAL,
	CUSTOM_MAX_SEASONS,
	CUSTOM_NAME_MAX,
	CUSTOM_OVERVIEW_MAX,
	CUSTOM_TITLE_MAX,
	customMediaInputSchema,
	totalEpisodes
} from './custom-media';

function input(over: Record<string, unknown> = {}) {
	return {
		title: 'A Title',
		type: 'movie',
		year: 1986,
		overview: '',
		seasons: [],
		credits: [],
		...over
	};
}

function credit(over: Record<string, unknown> = {}) {
	return { role: 'cast', name: 'Tomas Ilie', character: '', ...over };
}

const ok = (value: unknown) => customMediaInputSchema.safeParse(value).success;

describe('customMediaInputSchema', () => {
	it('accepts a minimal movie', () => {
		expect(ok(input())).toBe(true);
		expect(ok(input({ year: null, overview: '' }))).toBe(true);
	});

	it('bounds the overview and trims it, like the title', () => {
		expect(ok(input({ overview: 'x'.repeat(CUSTOM_OVERVIEW_MAX) }))).toBe(true);
		expect(ok(input({ overview: 'x'.repeat(CUSTOM_OVERVIEW_MAX + 1) }))).toBe(false);
		// Trimmed *before* the bound, so trailing whitespace can't push a valid synopsis over it.
		const parsed = customMediaInputSchema.safeParse(
			input({ overview: `  ${'x'.repeat(CUSTOM_OVERVIEW_MAX)}  ` })
		);
		expect(parsed.success && parsed.data.overview).toBe('x'.repeat(CUSTOM_OVERVIEW_MAX));
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

	it('accepts credits with or without a person id and a character', () => {
		expect(ok(input({ credits: [credit()] }))).toBe(true);
		expect(ok(input({ credits: [credit({ character: 'The Courier' })] }))).toBe(true);
		expect(
			ok(input({ credits: [credit({ personId: '44444444-4444-4444-8444-444444444444' })] }))
		).toBe(true);
		expect(ok(input({ credits: [credit({ role: 'director' })] }))).toBe(true);
	});

	it('requires a real name and a known role', () => {
		expect(ok(input({ credits: [credit({ name: '' })] }))).toBe(false);
		expect(ok(input({ credits: [credit({ name: '   ' })] }))).toBe(false);
		expect(ok(input({ credits: [credit({ name: 'x'.repeat(CUSTOM_NAME_MAX + 1) })] }))).toBe(false);
		expect(ok(input({ credits: [credit({ role: 'gaffer' })] }))).toBe(false);
	});

	it('rejects a supplied person id that is not one we could have minted', () => {
		expect(ok(input({ credits: [credit({ personId: 'not-a-uuid' })] }))).toBe(false);
	});

	it('rejects the same person credited twice in one role, but allows two roles', () => {
		// `(person, role)` is the primary key on both sides, so a duplicate would collapse on save.
		expect(ok(input({ credits: [credit(), credit()] }))).toBe(false);
		// Case and surrounding space don't make it a different person.
		expect(ok(input({ credits: [credit(), credit({ name: '  tomas ilie  ' })] }))).toBe(false);
		expect(ok(input({ credits: [credit(), credit({ role: 'director' })] }))).toBe(true);
	});

	it('accepts a provider hint on a picked person, and rejects a malformed one', () => {
		// Set when the author picked someone out of search rather than typing a bare name. Neither
		// field is identity — the shape check is there so a push can't smuggle arbitrary strings into
		// a person row or an image path.
		expect(
			ok(input({ credits: [credit({ externalId: 'person/137427', profilePath: '/dv.jpg' })] }))
		).toBe(true);
		expect(ok(input({ credits: [credit({ externalId: null, profilePath: null })] }))).toBe(true);

		expect(ok(input({ credits: [credit({ externalId: '137427' })] }))).toBe(false);
		expect(ok(input({ credits: [credit({ externalId: 'movie/603' })] }))).toBe(false);
		expect(ok(input({ credits: [credit({ profilePath: 'https://evil.test/x.jpg' })] }))).toBe(
			false
		);
		expect(ok(input({ credits: [credit({ profilePath: '/../secrets' })] }))).toBe(false);
	});

	it('bounds how many people one entry credits', () => {
		const many = (n: number) =>
			Array.from({ length: n }, (_, i) => credit({ name: `Person ${i}` }));
		expect(ok(input({ credits: many(CUSTOM_MAX_CREDITS) }))).toBe(true);
		expect(ok(input({ credits: many(CUSTOM_MAX_CREDITS + 1) }))).toBe(false);
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
