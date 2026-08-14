/**
 * Presentation helpers for cast and crew, shared by the authoring form and the match comparison.
 * Client-safe and pure — no store access, no server imports.
 *
 * Flat rather than under `src/lib/media/`, which would collide with the existing `src/lib/media.ts`.
 */
import { CREDIT_ROLES, type CreditRole, type MediaCredit } from '$lib/sync/events';

const ROLE_LABELS: Record<CreditRole, { one: string; many: string }> = {
	cast: { one: 'Cast', many: 'Cast' },
	director: { one: 'Director', many: 'Directors' },
	writer: { one: 'Writer', many: 'Writers' },
	producer: { one: 'Producer', many: 'Producers' },
	creator: { one: 'Creator', many: 'Creators' }
};

/** A role's display name, pluralized by how many people hold it. */
export function creditRoleLabel(role: CreditRole, count = 1): string {
	const label = ROLE_LABELS[role];
	return count === 1 ? label.one : label.many;
}

/** One role's people, in billing order. */
export interface CreditGroup {
	role: CreditRole;
	label: string;
	people: MediaCredit[];
}

/**
 * Group credits by role for rendering, in a fixed role order rather than whatever order the rows
 * arrived in — so a title and the entry it might match line up section for section. Roles nobody
 * holds are dropped.
 */
export function groupCredits(credits: MediaCredit[]): CreditGroup[] {
	const groups: CreditGroup[] = [];
	for (const role of CREDIT_ROLES) {
		const people = credits
			.filter((c) => c.role === role)
			.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
		if (people.length > 0)
			groups.push({ role, label: creditRoleLabel(role, people.length), people });
	}
	return groups;
}

/**
 * Fold a name for comparison: case, accents and punctuation removed, whitespace collapsed. Enough
 * to see that "Léa Seydoux" and "Lea  Seydoux" are the same person without pretending to be a
 * fuzzy matcher — the comparison view shows the user both lists and lets them decide.
 */
export function foldName(name: string): string {
	return name
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}
