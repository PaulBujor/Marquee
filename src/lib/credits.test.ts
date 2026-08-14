import { describe, expect, it } from 'vitest';
import { creditRoleLabel, foldName, groupCredits } from './credits';
import type { MediaCredit } from '$lib/sync/events';

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
