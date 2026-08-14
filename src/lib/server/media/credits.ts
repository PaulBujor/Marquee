/**
 * Persist a title's cast and crew. The data is already fetched by `refreshMedia` — this stores it
 * for offline access and cross-entry comparison. `people` rows are shared reference data.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { credits, people, type CreditRow, type Person } from '$lib/server/db/schema';
import { chunkBySize, chunkIds, chunkRows, D1_MAX_BOUND_PARAMS } from '$lib/server/db/chunk';
import { personId, type CreditRole, type MediaCredit } from '$lib/sync/events';
import type { createDb } from '$lib/server/db';
import type { MediaDetail } from '$lib/server/tmdb';

type Db = ReturnType<typeof createDb>;
type PersonInsert = typeof people.$inferInsert;
type CreditInsert = typeof credits.$inferInsert;

/** Mutable columns compared to decide whether a row needs rewriting. */
const PERSON_CONTENT_FIELDS = ['name', 'profilePath'] as const;
const CREDIT_CONTENT_FIELDS = ['character', 'sortOrder'] as const;

function contentChanged<K extends string>(
	a: Record<K, unknown>,
	b: Partial<Record<K, unknown>>,
	fields: readonly K[]
): boolean {
	return fields.some((f) => a[f] !== b[f]);
}

/** Flatten TMDB credits into person + credit rows. Duplicate credits for the same person/role collapse. */
export function creditRowsFromDetail(
	mediaId: string,
	detail: MediaDetail
): { personRows: PersonInsert[]; creditRows: CreditInsert[] } {
	const personRows = new Map<string, PersonInsert>();
	const creditRows = new Map<string, CreditInsert>();

	const add = (
		tmdbId: number,
		name: string,
		role: CreditRole,
		sortOrder: number,
		character: string | null,
		profilePath: string | null
	) => {
		if (!name) return;
		const id = personId('tmdb', tmdbId);
		if (!personRows.has(id)) {
			personRows.set(id, {
				id,
				provider: 'tmdb',
				externalId: `person/${tmdbId}`,
				ownerUserId: null,
				name,
				profilePath
			});
		}
		const key = `${id}:${role}`;
		if (!creditRows.has(key)) {
			creditRows.set(key, { mediaId, personId: id, role, character, sortOrder });
		}
	};

	detail.cast.forEach((c, i) => add(c.id, c.name, 'cast', i, c.character || null, c.profilePath));
	if (detail.director) add(detail.director.id, detail.director.name, 'director', 0, null, null);
	detail.writers.forEach((c, i) => add(c.id, c.name, 'writer', i, null, null));
	detail.producers.forEach((c, i) => add(c.id, c.name, 'producer', i, null, null));
	detail.creators.forEach((c, i) => add(c.id, c.name, 'creator', i, null, null));

	return { personRows: [...personRows.values()], creditRows: [...creditRows.values()] };
}

/** Stable signature of a credit set, to detect a content change without diffing field by field. */
export function creditSignature(
	rows: Pick<CreditInsert, 'personId' | 'role' | 'character' | 'sortOrder'>[]
): string {
	return rows
		.map((c) => [c.personId, c.role, c.character ?? '', c.sortOrder].join(':'))
		.sort()
		.join('|');
}

/** Upsert shared people rows — add/refresh only, never delete (another title may credit them). */
async function syncPeople(db: Db, rows: PersonInsert[]): Promise<void> {
	if (rows.length === 0) return;

	const existing = (
		await Promise.all(
			chunkIds(rows.map((r) => r.id)).map((ids) =>
				db.select().from(people).where(inArray(people.id, ids))
			)
		)
	).flat();
	const byId = new Map<string, Person>(existing.map((r) => [r.id, r]));

	const toUpsert = rows.filter((r) => {
		const old = byId.get(r.id);
		return !old || contentChanged(old, r, PERSON_CONTENT_FIELDS);
	});

	for (const chunk of chunkRows(toUpsert)) {
		await db
			.insert(people)
			.values(chunk)
			.onConflictDoUpdate({
				target: people.id,
				set: { name: sql`excluded.name`, profilePath: sql`excluded.profile_path` }
			});
	}
}

/** Reconcile a title's credits: upsert changed rows, delete disappeared ones. */
export async function syncCredits(
	db: Db,
	mediaId: string,
	personRows: PersonInsert[],
	newRows: CreditInsert[]
): Promise<void> {
	await syncPeople(db, personRows);

	const oldRows: CreditRow[] = await db.select().from(credits).where(eq(credits.mediaId, mediaId));
	const key = (r: { personId: string; role: string }) => `${r.personId}:${r.role}`;
	const oldByKey = new Map(oldRows.map((r) => [key(r), r]));
	const newKeys = new Set(newRows.map(key));

	const toUpsert = newRows.filter((r) => {
		const old = oldByKey.get(key(r));
		return !old || contentChanged(old, r, CREDIT_CONTENT_FIELDS);
	});
	const toDelete = oldRows.filter((r) => !newKeys.has(key(r)));

	for (const chunk of chunkRows(toUpsert)) {
		await db
			.insert(credits)
			.values(chunk)
			.onConflictDoUpdate({
				target: [credits.mediaId, credits.personId, credits.role],
				set: { character: sql`excluded.character`, sortOrder: sql`excluded.sort_order` }
			});
	}
	// One bound mediaId param plus two (person, role) params per deleted row.
	for (const chunk of chunkBySize(toDelete, Math.floor((D1_MAX_BOUND_PARAMS - 1) / 2))) {
		await db
			.delete(credits)
			.where(
				and(
					eq(credits.mediaId, mediaId),
					or(...chunk.map((r) => and(eq(credits.personId, r.personId), eq(credits.role, r.role))))
				)
			);
	}
}

/** Load a title's credits as wire records, ordered by role then billing. */
export async function loadCredits(db: Db, mediaId: string): Promise<MediaCredit[]> {
	const rows = await db
		.select({
			personId: credits.personId,
			role: credits.role,
			character: credits.character,
			sortOrder: credits.sortOrder,
			name: people.name,
			profilePath: people.profilePath
		})
		.from(credits)
		.innerJoin(people, eq(people.id, credits.personId))
		.where(eq(credits.mediaId, mediaId));

	return rows.sort((a, b) => a.role.localeCompare(b.role) || a.sortOrder - b.sortOrder);
}
