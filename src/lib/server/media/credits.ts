/**
 * Persisting a title's cast and crew.
 *
 * The data already arrives — `refreshMedia` fetches TMDB details with `append_to_response=credits`
 * and `normalizeDetails` turns it into `cast` / `director` / `writers` / `producers` / `creators`.
 * Storing it makes it available offline, lets a custom entry be compared against a candidate on
 * more than its title, and gives the reverse lookup ("everything this person worked on") a home.
 *
 * `people` rows are shared reference data keyed by our derived person id, so two titles crediting
 * the same actor converge on one row. Reconciliation mirrors `syncSeasons`/`syncEpisodes`: diff
 * against what's stored, write only what changed, delete what disappeared.
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
const PERSON_CONTENT_FIELDS = ['name', 'externalId', 'profilePath'] as const;
const CREDIT_CONTENT_FIELDS = ['character', 'sortOrder'] as const;

function contentChanged<K extends string>(
	a: Record<K, unknown>,
	b: Partial<Record<K, unknown>>,
	fields: readonly K[]
): boolean {
	return fields.some((f) => a[f] !== b[f]);
}

/**
 * Flatten a normalized TMDB detail into person + credit rows.
 *
 * A person credited twice in the same role (TMDB does this — an actor listed for two characters)
 * collapses to the first occurrence, because `(media, person, role)` is the primary key. Keeping
 * the first preserves billing order, which is the one thing the ordering is for.
 */
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

/**
 * Flatten a pushed custom record's credits into person + credit rows. The mirror of
 * {@link creditRowsFromDetail} for the one case the server can't fetch: people on a user's own
 * entry, stored owner-scoped and private.
 *
 * The row stays `provider: 'local'` even when it carries a provider external id. That id is a
 * *hint* — which real person the author picked out of search — not a claim on the shared catalog,
 * and keeping the provider local is what says so. Uniqueness is per owner (see the partial indexes
 * on `people`), so two accounts can each hold their own row pointing at the same person.
 *
 * People are collapsed by that hint, not by the id the client sent. The form mints a fresh id per
 * credit row and allows the same person under two roles, so crediting someone as director *and*
 * writer produces two ids naming one person — two rows that collide on `people_owner_external_idx`
 * and abort the whole push. Credits follow the id the collapse kept.
 */
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

		// Same collapse as the provider path: `(media, person, role)` is the primary key, and keeping
		// the first occurrence preserves the order the author put them in.
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

/** Stable signature of a credit set, to detect a content change without diffing field by field. */
export function creditSignature(
	rows: Pick<CreditInsert, 'personId' | 'role' | 'character' | 'sortOrder'>[]
): string {
	return rows
		.map((c) => [c.personId, c.role, c.character ?? '', c.sortOrder].join(':'))
		.sort()
		.join('|');
}

/** Load the stored rows for a set of person ids, keyed by id. */
async function loadPeople(db: Db, ids: string[]): Promise<Map<string, Person>> {
	if (ids.length === 0) return new Map();
	const rows = (
		await Promise.all(
			chunkIds(ids).map((chunk) => db.select().from(people).where(inArray(people.id, chunk)))
		)
	).flat();
	return new Map(rows.map((r) => [r.id, r]));
}

/** Write the rows whose content actually differs from what's stored. */
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

/**
 * Upsert the people a provider-backed title credits. Shared rows, so this only ever adds or
 * refreshes a name or photo — it never deletes, since another title may credit the same person.
 *
 * Only ever called with rows derived from a provider response. A person id the *client* supplied
 * must go through {@link syncOwnedPeople} instead, which won't write outside that user's own rows.
 */
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

/**
 * Upsert people a user authored, and report the id each pushed person is actually stored under.
 *
 * A person id on a custom entry is minted by the client, so a push can name an id that already
 * exists — including a provider person's, whose id is derivable by anyone. Such a row is left
 * untouched and its id left out of the result, so one account can never rewrite the name every
 * other title shows for that person. Same gate, same reasoning, as the media row's own `mayWrite`.
 *
 * The result is a mapping rather than a set because a person can arrive under a **new id for an
 * identity this user already stores**: the form mints an id per credit row, so crediting the same
 * searched person on a second entry sends a second id carrying the same `externalId`. Only one row
 * per `(owner, provider, external_id)` may exist, so the stored id wins and the caller re-points
 * the credit at it — otherwise the insert aborts the push and takes the whole media channel with it.
 */
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
		// An identity this user already holds under another id: keep the stored row, re-point the
		// credit. Its name/photo are left as they are — the hint says it's the same person either way.
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

/** This user's own person rows carrying any of `externalIds`, keyed by external id. */
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

/**
 * Reconcile a title's credits against what's stored: upsert new or changed rows, delete the ones
 * that disappeared (a re-credited film, a corrected cast list), leave unchanged rows untouched.
 * The people they name must already exist — a credit is a foreign key onto them.
 */
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

/** Order credits so roles group together and each role keeps its billing — a renderer can section
 *  without re-sorting, and two clients always agree on the order. */
function byRoleThenBilling(a: MediaCredit, b: MediaCredit): number {
	return a.role.localeCompare(b.role) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
}

/** Load a title's credits as wire records. */
export async function loadCredits(db: Db, mediaId: string): Promise<MediaCredit[]> {
	return (await loadCreditsForMedia(db, [mediaId])).get(mediaId) ?? [];
}

/**
 * Credits for many titles in one pass, keyed by media id. The media channel returns whole batches,
 * so a per-title query there would be one round trip per row.
 */
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
