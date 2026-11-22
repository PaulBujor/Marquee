/** `people` rows are shared reference data keyed by our derived person id, so two titles crediting the same actor converge on one row. */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { credits, people, type CreditRow, type Person } from '#lib/server/db/schema.js';
import { chunkBySize, chunkIds, chunkRows, D1_MAX_BOUND_PARAMS } from '#lib/server/db/chunk.js';
import { personId, type CreditRole, type MediaCredit } from '#lib/sync/events.js';
import type { createDb } from '#lib/server/db/index.js';
import type { MediaDetail } from '#lib/server/tmdb/index.js';

type Db = ReturnType<typeof createDb>;
type PersonInsert = typeof people.$inferInsert;
type CreditInsert = typeof credits.$inferInsert;

const PERSON_CONTENT_FIELDS = ['name', 'externalId', 'profilePath'] as const;
const CREDIT_CONTENT_FIELDS = ['character', 'sortOrder'] as const;

function contentChanged<K extends string>(
	a: Record<K, unknown>,
	b: Partial<Record<K, unknown>>,
	fields: readonly K[]
): boolean {
	return fields.some((f) => a[f] !== b[f]);
}

/** A person credited twice in one role collapses to the first, because `(media, person, role)` is the primary key — which also preserves billing order. */
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

/** Rows stay `provider: 'local'` even when they carry a provider external id — that id is a hint about which real person the author picked, not a claim on the shared catalog. */
export function creditRowsFromCustom(
	mediaId: string,
	userId: string,
	pushed: MediaCredit[]
): { personRows: PersonInsert[]; creditRows: CreditInsert[] } {
	const personRows = new Map<string, PersonInsert>();
	const creditRows = new Map<string, CreditInsert>();

	for (const c of pushed) {
		// A null hint identifies nobody, so a typed-in name stays on its own id.
		const identity = c.externalId === null ? `id:${c.personId}` : `ext:${c.externalId}`;
		const existing = personRows.get(identity);
		if (!existing) {
			personRows.set(identity, {
				id: c.personId,
				provider: 'local',
				externalId: c.externalId,
				ownerUserId: userId,
				name: c.name,
				profilePath: c.profilePath
			});
		}
		const storedId = existing?.id ?? c.personId;

		// Same collapse as the provider path: `(media, person, role)` is the primary key, and the first occurrence keeps the author's order.
		const key = `${storedId}:${c.role}`;
		if (!creditRows.has(key)) {
			creditRows.set(key, {
				mediaId,
				personId: storedId,
				role: c.role,
				character: c.character,
				sortOrder: c.sortOrder
			});
		}
	}

	return { personRows: [...personRows.values()], creditRows: [...creditRows.values()] };
}

export function creditSignature(
	rows: Pick<CreditInsert, 'personId' | 'role' | 'character' | 'sortOrder'>[]
): string {
	return rows
		.map((c) => [c.personId, c.role, c.character ?? '', c.sortOrder].join(':'))
		.sort()
		.join('|');
}

async function loadPeople(db: Db, ids: string[]): Promise<Map<string, Person>> {
	if (ids.length === 0) return new Map();
	const rows = (
		await Promise.all(
			chunkIds(ids).map((chunk) => db.select().from(people).where(inArray(people.id, chunk)))
		)
	).flat();
	return new Map(rows.map((r) => [r.id, r]));
}

async function upsertPeople(db: Db, rows: PersonInsert[]): Promise<void> {
	for (const chunk of chunkRows(rows)) {
		await db
			.insert(people)
			.values(chunk)
			.onConflictDoUpdate({
				target: people.id,
				set: {
					name: sql`excluded.name`,
					// Re-picking a different person out of search rewrites the hint on the same owned row.
					externalId: sql`excluded.external_id`,
					profilePath: sql`excluded.profile_path`
				}
			});
	}
}

/** Shared rows: only ever adds or refreshes a name or photo — never deletes, since another title may credit the same person. */
export async function syncProviderPeople(db: Db, rows: PersonInsert[]): Promise<void> {
	if (rows.length === 0) return;
	const byId = await loadPeople(
		db,
		rows.map((r) => r.id)
	);
	await upsertPeople(
		db,
		rows.filter((r) => {
			const old = byId.get(r.id);
			return !old || contentChanged(old, r, PERSON_CONTENT_FIELDS);
		})
	);
}

/** A client-minted id can collide with a provider person's, whose id is derivable by anyone — such a row is left untouched and its id withheld. */
export async function syncOwnedPeople(
	db: Db,
	userId: string,
	rows: PersonInsert[]
): Promise<Map<string, string>> {
	if (rows.length === 0) return new Map();
	const [byId, byExternalId] = await Promise.all([
		loadPeople(
			db,
			rows.map((r) => r.id)
		),
		loadOwnedPeopleByExternalId(
			db,
			userId,
			rows.map((r) => r.externalId)
		)
	]);

	const canonical = new Map<string, string>();
	const toWrite: PersonInsert[] = [];
	for (const row of rows) {
		// An identity this user already holds under another id: keep the stored row, re-point the credit.
		const owned = typeof row.externalId === 'string' ? byExternalId.get(row.externalId) : undefined;
		if (owned && owned.id !== row.id) {
			canonical.set(row.id, owned.id);
			continue;
		}
		const old = byId.get(row.id);
		if (old && old.ownerUserId !== userId) continue; // not this user's to write
		canonical.set(row.id, row.id);
		if (!old || contentChanged(old, row, PERSON_CONTENT_FIELDS)) toWrite.push(row);
	}

	await upsertPeople(db, toWrite);
	return canonical;
}

async function loadOwnedPeopleByExternalId(
	db: Db,
	userId: string,
	externalIds: (string | null | undefined)[]
): Promise<Map<string, Person>> {
	const ids = [...new Set(externalIds.filter((e): e is string => typeof e === 'string'))];
	if (ids.length === 0) return new Map();
	const rows = (
		await Promise.all(
			chunkIds(ids).map((chunk) =>
				db
					.select()
					.from(people)
					.where(and(eq(people.ownerUserId, userId), inArray(people.externalId, chunk)))
			)
		)
	).flat();
	return new Map(rows.map((r) => [r.externalId as string, r]));
}

/** People must already exist — a credit is a foreign key onto them. */
export async function syncCredits(db: Db, mediaId: string, newRows: CreditInsert[]): Promise<void> {
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

/** Group roles together and keep each role's billing, so a renderer can section without re-sorting and two clients always agree. */
function byRoleThenBilling(a: MediaCredit, b: MediaCredit): number {
	return a.role.localeCompare(b.role) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
}

export async function loadCredits(db: Db, mediaId: string): Promise<MediaCredit[]> {
	return (await loadCreditsForMedia(db, [mediaId])).get(mediaId) ?? [];
}

/** One pass for a whole batch — a per-title query would be one round trip per row. */
export async function loadCreditsForMedia(
	db: Db,
	mediaIds: string[]
): Promise<Map<string, MediaCredit[]>> {
	const byMedia = new Map<string, MediaCredit[]>();
	if (mediaIds.length === 0) return byMedia;

	const rows = (
		await Promise.all(
			chunkIds(mediaIds).map((ids) =>
				db
					.select({
						mediaId: credits.mediaId,
						personId: credits.personId,
						role: credits.role,
						character: credits.character,
						sortOrder: credits.sortOrder,
						externalId: people.externalId,
						name: people.name,
						profilePath: people.profilePath
					})
					.from(credits)
					.innerJoin(people, eq(people.id, credits.personId))
					.where(inArray(credits.mediaId, ids))
			)
		)
	).flat();

	for (const { mediaId, ...credit } of rows) {
		const list = byMedia.get(mediaId);
		if (list) list.push(credit);
		else byMedia.set(mediaId, [credit]);
	}
	for (const list of byMedia.values()) list.sort(byRoleThenBilling);
	return byMedia;
}
