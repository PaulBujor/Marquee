import {
	CREDIT_ROLES,
	personExternalId,
	personId,
	type CreditRole,
	type MediaCredit
} from '#lib/sync/events.js';
import type { MediaDetail } from '#lib/server/tmdb/index.js';

const ROLE_LABELS: Record<CreditRole, { one: string; many: string }> = {
	cast: { one: 'Cast', many: 'Cast' },
	director: { one: 'Director', many: 'Directors' },
	writer: { one: 'Writer', many: 'Writers' },
	producer: { one: 'Producer', many: 'Producers' },
	creator: { one: 'Creator', many: 'Creators' }
};

export function creditRoleLabel(role: CreditRole, count = 1): string {
	const label = ROLE_LABELS[role];
	return count === 1 ? label.one : label.many;
}

export interface CreditGroup {
	role: CreditRole;
	label: string;
	people: MediaCredit[];
}

// Sections follow CREDIT_ROLES, not row arrival order, so a title and its candidate line up section for section.
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

// Deliberately not a fuzzy matcher: both lists are shown and the user decides.
export function foldName(name: string): string {
	return name
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

type DetailCredits = Pick<MediaDetail, 'cast' | 'director' | 'writers' | 'producers' | 'creators'>;

// Ids are derived exactly as the server derives them, so an unsaved candidate and its stored row agree on who a person is.
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

export interface CreditOverlap {
	/** Folded names present on both sides. */
	shared: Set<string>;
	total: number;
	matched: number;
}

// Ignores role: someone filed as "director" here and credited "writer" there is still the same person.
export function compareCredits(mine: MediaCredit[], theirs: MediaCredit[]): CreditOverlap {
	const mineFolded = new Set(mine.map((c) => foldName(c.name)).filter((n) => n !== ''));
	const theirsFolded = new Set(theirs.map((c) => foldName(c.name)).filter((n) => n !== ''));
	const shared = new Set([...mineFolded].filter((n) => theirsFolded.has(n)));
	return { shared, total: mineFolded.size, matched: shared.size };
}
