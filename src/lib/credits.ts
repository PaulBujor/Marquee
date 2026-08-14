/** Presentation helpers for cast and crew: labels, grouping, name comparison. Client-safe. */
import {
	CREDIT_ROLES,
	personExternalId,
	personId,
	type CreditRole,
	type MediaCredit
} from '$lib/sync/events';
// Type-only import of the API contract shape — erased at build, so no server code reaches the client.
import type { MediaDetail } from '$lib/server/tmdb';

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

/** The credit shape a provider detail response carries, before anything of ours is stored. */
type DetailCredits = Pick<MediaDetail, 'cast' | 'director' | 'writers' | 'producers' | 'creators'>;

/** Wire credits from a provider detail response, derived the same way the server does. */
export function creditsFromDetail(detail: DetailCredits): MediaCredit[] {
	const out: MediaCredit[] = [];
	const add = (
		tmdbId: number,
		name: string,
		role: CreditRole,
		sortOrder: number,
		character: string | null,
		profilePath: string | null
	) => {
		if (!name) return;
		out.push({
			personId: personId('tmdb', tmdbId),
			externalId: personExternalId(tmdbId),
			name,
			profilePath,
			role,
			character,
			sortOrder
		});
	};

	detail.cast.forEach((c, i) => add(c.id, c.name, 'cast', i, c.character || null, c.profilePath));
	if (detail.director) add(detail.director.id, detail.director.name, 'director', 0, null, null);
	detail.writers.forEach((c, i) => add(c.id, c.name, 'writer', i, null, null));
	detail.producers.forEach((c, i) => add(c.id, c.name, 'producer', i, null, null));
	detail.creators.forEach((c, i) => add(c.id, c.name, 'creator', i, null, null));
	return out;
}

/** How much of one credit list turns up in another. */
export interface CreditOverlap {
	/** Folded names present on both sides — what the comparison highlights. */
	shared: Set<string>;
	/** Distinct people on the left. */
	total: number;
	/** How many of them the right side also credits. */
	matched: number;
}

/** Compare two credit lists by folded name (ignoring role). Reports counts; matching nothing isn't evidence. */
export function compareCredits(mine: MediaCredit[], theirs: MediaCredit[]): CreditOverlap {
	const mineFolded = new Set(mine.map((c) => foldName(c.name)).filter((n) => n !== ''));
	const theirsFolded = new Set(theirs.map((c) => foldName(c.name)).filter((n) => n !== ''));
	const shared = new Set([...mineFolded].filter((n) => theirsFolded.has(n)));
	return { shared, total: mineFolded.size, matched: shared.size };
}
