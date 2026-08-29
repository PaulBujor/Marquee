import { describe, expect, it } from 'vitest';
import { createCustomMedia, customEpisodeAirDate, toCustomMediaInput } from './custom-media';
import {
	CUSTOM_OVERVIEW_MAX,
	customMediaInputSchema,
	type CustomMediaInput
} from '$lib/validation/custom-media';
import {
	isAired,
	isSeriesFullyWatched,
	nextEpisode,
	todayIso,
	watchedKey
} from '$lib/tracking/actions';

const NOW = Date.UTC(2026, 7, 14); // 2026-08-14
const TODAY = '2026-08-14';

function input(over: Partial<CustomMediaInput> = {}): CustomMediaInput {
	return {
		title: 'Midnight Cassette Club',
		type: 'movie',
		year: 1986,
		overview: '',
		seasons: [],
		credits: [],
		...over
	};
}

/** Deterministic ids for the people a record mints, so assertions can name them. */
function mintIds(prefix = 'person'): () => string {
	let n = 0;
	return () => `${prefix}-${n++}`;
}

describe('customEpisodeAirDate', () => {
	it('uses the start of the entry year when there is one', () => {
		expect(customEpisodeAirDate(1986, NOW)).toBe('1986-01-01');
	});

	it('falls back to today when the year is unknown', () => {
		expect(customEpisodeAirDate(null, NOW)).toBe(TODAY);
	});

	it('clamps a future year to today so the episodes stay watchable', () => {
		// A date ahead of today would make every episode read as not-yet-aired, which is exactly the
		// state that makes an episode unmarkable.
		expect(customEpisodeAirDate(2030, NOW)).toBe(TODAY);
	});

	it('zero-pads an early year so the date still compares lexicographically', () => {
		expect(customEpisodeAirDate(900, NOW)).toBe('0900-01-01');
	});
});

describe('createCustomMedia', () => {
	it('mints a random id rather than deriving one', () => {
		const a = createCustomMedia(input(), { now: NOW });
		const b = createCustomMedia(input(), { now: NOW });
		expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		// Same inputs, different ids — two people cataloguing the same obscure film keep separate,
		// private entries, and neither can compute the other's.
		expect(a.id).not.toBe(b.id);
	});

	it('builds a movie with no children and nothing provider-shaped', () => {
		const record = createCustomMedia(input(), { now: NOW });
		expect(record).toMatchObject({
			provider: 'local',
			externalId: null,
			source: 'custom',
			type: 'movie',
			title: 'Midnight Cassette Club',
			year: 1986,
			posterPath: null,
			backdropPath: null,
			status: null,
			inProduction: null,
			version: 0,
			seasons: null,
			episodes: null
		});
	});

	it('trims the title and overview', () => {
		const record = createCustomMedia(input({ title: '  Spaced  ', overview: '  Text  ' }), {
			now: NOW
		});
		expect(record.title).toBe('Spaced');
		expect(record.overview).toBe('Text');
	});

	it('keeps a supplied id, so an edit rewrites the entry rather than forking it', () => {
		const record = createCustomMedia(input({ title: 'Renamed' }), { id: 'fixed-id', now: NOW });
		expect(record.id).toBe('fixed-id');
	});

	it('fans season episode counts out into individual episodes', () => {
		const record = createCustomMedia(
			input({
				type: 'show',
				seasons: [
					{ seasonNumber: 1, episodeCount: 3 },
					{ seasonNumber: 2, episodeCount: 2 }
				]
			}),
			{ now: NOW }
		);
		expect(record.seasons).toHaveLength(2);
		expect(record.episodes).toHaveLength(5);
		expect(record.episodes?.map((e) => `${e.season}x${e.episode}`)).toEqual([
			'1x1',
			'1x2',
			'1x3',
			'2x1',
			'2x2'
		]);
		expect(record.seasons?.[1]).toMatchObject({ seasonNumber: 2, episodeCount: 2 });
	});

	it('orders seasons even when the form collected them out of order', () => {
		const record = createCustomMedia(
			input({
				type: 'show',
				seasons: [
					{ seasonNumber: 3, episodeCount: 1 },
					{ seasonNumber: 1, episodeCount: 1 }
				]
			}),
			{ now: NOW }
		);
		expect(record.seasons?.map((s) => s.seasonNumber)).toEqual([1, 3]);
	});

	it('marks a show as not in production, so it can reach completed', () => {
		const record = createCustomMedia(input({ type: 'show', seasons: [] }), { now: NOW });
		expect(record.inProduction).toBe(false);
	});

	it('produces episodes the existing tracking helpers treat as watchable', () => {
		// The whole reason air dates are synthesized rather than left null: every one of these
		// helpers reads a null date as "not yet aired" and would refuse to act on the episode.
		const record = createCustomMedia(
			input({ type: 'show', seasons: [{ seasonNumber: 1, episodeCount: 2 }] }),
			{ now: NOW }
		);
		const episodes = record.episodes ?? [];
		const today = todayIso(NOW);

		expect(episodes.every((e) => isAired(e, today))).toBe(true);
		expect(nextEpisode(episodes, new Set(), today)).toEqual({ season: 1, episode: 1 });

		const watched = new Set(episodes.map((e) => watchedKey(e.season, e.episode)));
		expect(isSeriesFullyWatched(episodes, watched, today)).toBe(true);
	});

	it('produces a record its own validation schema accepts', () => {
		const value = input({ type: 'show', seasons: [{ seasonNumber: 1, episodeCount: 2 }] });
		expect(customMediaInputSchema.safeParse(value).success).toBe(true);
	});

	it('mints an id per credited person and numbers billing within each role', () => {
		const record = createCustomMedia(
			input({
				credits: [
					{ role: 'cast', name: 'Tomas Ilie', character: 'The Courier' },
					{ role: 'cast', name: 'Renata Voss', character: '' },
					{ role: 'director', name: 'Ana Petrescu', character: '' }
				]
			}),
			{ now: NOW, mintPersonId: mintIds() }
		);

		expect(record.credits).toEqual([
			{
				personId: 'person-0',
				externalId: null,
				name: 'Tomas Ilie',
				profilePath: null,
				role: 'cast',
				character: 'The Courier',
				sortOrder: 0
			},
			{
				personId: 'person-1',
				externalId: null,
				name: 'Renata Voss',
				profilePath: null,
				role: 'cast',
				// Blank means they played nobody named, which is null on the wire, not an empty string.
				character: null,
				sortOrder: 1
			},
			{
				personId: 'person-2',
				externalId: null,
				name: 'Ana Petrescu',
				profilePath: null,
				role: 'director',
				character: null,
				// Billing restarts per role, so each section is ordered on its own.
				sortOrder: 0
			}
		]);
	});

	it('keeps a person id an edit supplies, so re-saving credits the same person', () => {
		const record = createCustomMedia(
			input({
				credits: [{ personId: 'kept', role: 'writer', name: 'Renata Voss', character: '' }]
			}),
			{ now: NOW, mintPersonId: mintIds() }
		);
		expect(record.credits?.[0].personId).toBe('kept');
	});

	it('ignores a character typed against a crew role', () => {
		// The form hides the field for crew, but the input shape allows it — a producer never played
		// anyone, and storing one would put nonsense on the comparison view.
		const record = createCustomMedia(
			input({ credits: [{ role: 'producer', name: 'Renata Voss', character: 'Herself' }] }),
			{ now: NOW, mintPersonId: mintIds() }
		);
		expect(record.credits?.[0].character).toBeNull();
	});
});

describe('createCustomMedia with fields the schema never saw', () => {
	// `planImport` builds its input by hand from an export document, where `overview`, `character`
	// and `name` are all optional-and-nullable. Nothing validates that input before it lands here, so
	// a missing field has to normalize rather than throw halfway through building the record.
	const loose = (over: Record<string, unknown>) =>
		input(over as Partial<CustomMediaInput>) as unknown as CustomMediaInput;

	it('reads a missing overview as empty', () => {
		expect(createCustomMedia(loose({ overview: null }), { now: NOW }).overview).toBe('');
		expect(createCustomMedia(loose({ overview: undefined }), { now: NOW }).overview).toBe('');
	});

	it('reads a missing character or name as empty', () => {
		const record = createCustomMedia(
			loose({ credits: [{ role: 'cast', name: 'Tomas Ilie', character: null }] }),
			{ now: NOW, mintPersonId: mintIds() }
		);
		expect(record.credits?.[0]).toMatchObject({ name: 'Tomas Ilie', character: null });
	});
});

describe('toCustomMediaInput', () => {
	it('clamps an overview stored under a looser bound', () => {
		// Otherwise the form seeds a value its own schema then refuses, and the entry can never be
		// edited again.
		const record = createCustomMedia(input(), { now: NOW });
		const stored = { ...record, overview: 'x'.repeat(CUSTOM_OVERVIEW_MAX + 500) };
		expect(toCustomMediaInput(stored, []).overview).toHaveLength(CUSTOM_OVERVIEW_MAX);
	});

	it('round-trips a show back to the form values it was built from', () => {
		const original = input({
			type: 'show',
			seasons: [
				{ seasonNumber: 1, episodeCount: 3 },
				{ seasonNumber: 2, episodeCount: 2 }
			]
		});
		const record = createCustomMedia(original, { now: NOW });
		expect(toCustomMediaInput(record, record.seasons ?? [])).toEqual(original);
	});

	it('drops seasons for a movie even if some were somehow stored', () => {
		const record = createCustomMedia(input(), { now: NOW });
		expect(toCustomMediaInput(record, [{ seasonNumber: 1, episodeCount: 4 }]).seasons).toEqual([]);
	});

	it('carries credits back with their person ids, so an edit re-saves the same people', () => {
		const original = input({
			credits: [
				{ role: 'cast', name: 'Tomas Ilie', character: 'The Courier' },
				{ role: 'director', name: 'Ana Petrescu', character: '' }
			]
		});
		const record = createCustomMedia(original, { now: NOW, mintPersonId: mintIds() });

		const back = toCustomMediaInput(record, [], record.credits ?? []);
		expect(back.credits).toEqual([
			{
				personId: 'person-0',
				role: 'cast',
				name: 'Tomas Ilie',
				character: 'The Courier',
				externalId: null,
				profilePath: null
			},
			{
				personId: 'person-1',
				role: 'director',
				name: 'Ana Petrescu',
				character: '',
				externalId: null,
				profilePath: null
			}
		]);

		// And re-saving that input keeps every id rather than minting new rows.
		const resaved = createCustomMedia(back, {
			id: record.id,
			now: NOW,
			mintPersonId: mintIds('fresh')
		});
		expect(resaved.credits?.map((c) => c.personId)).toEqual(['person-0', 'person-1']);
	});
});
