import { describe, expect, it } from 'vitest';
import {
	compareCredits,
	creditRoleLabel,
	creditsFromDetail,
	foldName,
	groupCredits
} from './credits';
import { personExternalId, personId, type MediaCredit } from '$lib/sync/events';

function credit(over: Partial<MediaCredit> & Pick<MediaCredit, 'name' | 'role'>): MediaCredit {
	return {
		personId: over.name,
		externalId: null,
		profilePath: null,
		character: null,
		sortOrder: 0,
		...over
	};
}

describe('creditRoleLabel', () => {
	it('pluralizes by how many people hold the role', () => {
		expect(creditRoleLabel('director')).toBe('Director');
		expect(creditRoleLabel('director', 2)).toBe('Directors');
		// "Cast" is already a collective noun — "Casts" would be wrong at any count.
		expect(creditRoleLabel('cast', 5)).toBe('Cast');
	});
});

describe('groupCredits', () => {
	it('groups by role in a fixed order, keeping billing within each', () => {
		const groups = groupCredits([
			credit({ name: 'A Producer', role: 'producer' }),
			credit({ name: 'Second Billed', role: 'cast', sortOrder: 1 }),
			credit({ name: 'Top Billed', role: 'cast', sortOrder: 0 }),
			credit({ name: 'A Director', role: 'director' })
		]);

		// Fixed role order, not arrival order — so a custom entry and a candidate line up section for
		// section in the comparison view.
		expect(groups.map((g) => g.role)).toEqual(['cast', 'director', 'producer']);
		expect(groups[0].people.map((p) => p.name)).toEqual(['Top Billed', 'Second Billed']);
		expect(groups[0].label).toBe('Cast');
	});

	it('drops roles nobody holds, and returns nothing for an empty list', () => {
		expect(groupCredits([]).length).toBe(0);
		expect(groupCredits([credit({ name: 'Solo', role: 'writer' })]).map((g) => g.role)).toEqual([
			'writer'
		]);
	});
});

describe('creditsFromDetail', () => {
	const detail = {
		cast: [
			{ id: 6193, name: 'Leonardo DiCaprio', character: 'Cobb', profilePath: '/leo.jpg' },
			{ id: 24045, name: 'Joseph Gordon-Levitt', character: '', profilePath: null }
		],
		director: { id: 525, name: 'Christopher Nolan' },
		writers: [{ id: 525, name: 'Christopher Nolan' }],
		producers: [{ id: 947, name: 'Emma Thomas' }],
		creators: []
	};

	it('derives the same person ids the server does, so both sides agree on who someone is', () => {
		const credits = creditsFromDetail(detail);
		const nolan = credits.filter((c) => c.name === 'Christopher Nolan');
		expect(nolan.map((c) => c.role)).toEqual(['director', 'writer']);
		expect(nolan[0].personId).toBe(personId('tmdb', 525));
		expect(nolan[0].externalId).toBe(personExternalId(525));
	});

	it('numbers billing within each role and normalizes a blank character to null', () => {
		const credits = creditsFromDetail(detail);
		const cast = credits.filter((c) => c.role === 'cast');
		expect(cast.map((c) => c.sortOrder)).toEqual([0, 1]);
		expect(cast[0].character).toBe('Cobb');
		expect(cast[1].character).toBeNull();
	});

	it('skips an unnamed person rather than producing a blank credit', () => {
		const credits = creditsFromDetail({
			...detail,
			cast: [{ id: 9, name: '', character: 'Extra', profilePath: null }]
		});
		expect(credits.some((c) => c.role === 'cast')).toBe(false);
	});
});

describe('compareCredits', () => {
	it('counts the people on both sides regardless of the role each filed them under', () => {
		// The user filed them as director, the provider as writer — still the same person turning up
		// twice, which is the signal the comparison is for.
		const overlap = compareCredits(
			[credit({ name: 'Ana Petrescu', role: 'director' })],
			[credit({ name: 'Ana Petrescu', role: 'writer' })]
		);
		expect(overlap).toMatchObject({ total: 1, matched: 1 });
		expect(overlap.shared.has('ana petrescu')).toBe(true);
	});

	it('matches across spelling differences the fold ignores', () => {
		const overlap = compareCredits(
			[credit({ name: 'Léa Seydoux', role: 'cast' })],
			[credit({ name: 'Lea Seydoux', role: 'cast' })]
		);
		expect(overlap.matched).toBe(1);
	});

	it('counts distinct people, not credits', () => {
		// Someone credited in two roles is one person to cross-check, not two.
		const overlap = compareCredits(
			[
				credit({ name: 'Ana Petrescu', role: 'director' }),
				credit({ name: 'Ana Petrescu', role: 'writer' })
			],
			[credit({ name: 'Ana Petrescu', role: 'director' })]
		);
		expect(overlap).toMatchObject({ total: 1, matched: 1 });
	});

	it('reports no overlap without claiming the titles differ', () => {
		const overlap = compareCredits(
			[credit({ name: 'Ana Petrescu', role: 'director' })],
			[credit({ name: 'Christopher Nolan', role: 'director' })]
		);
		expect(overlap).toMatchObject({ total: 1, matched: 0 });
		expect(overlap.shared.size).toBe(0);
	});

	it('handles an entry that credits nobody', () => {
		expect(compareCredits([], [credit({ name: 'Anyone', role: 'cast' })])).toMatchObject({
			total: 0,
			matched: 0
		});
	});
});

describe('foldName', () => {
	it('ignores case, accents, punctuation and extra spacing', () => {
		expect(foldName('Léa Seydoux')).toBe(foldName('Lea  Seydoux'));
		expect(foldName('Joseph Gordon-Levitt')).toBe(foldName('joseph gordon levitt'));
		expect(foldName("  Renata O'Voss  ")).toBe('renata o voss');
	});

	it('still tells different people apart', () => {
		expect(foldName('Ana Petrescu')).not.toBe(foldName('Ana Petrescou'));
	});
});
