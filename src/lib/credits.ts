/** Presentation helpers for cast and crew: role labels, grouping, name comparison. Client-safe. */
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

/** Group credits by role in fixed order, dropping empty roles. */
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

/** Fold a name for comparison: strip accents, lowercase, collapse whitespace/punctuation. */
export function foldName(name: string): string {
	return name
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}
