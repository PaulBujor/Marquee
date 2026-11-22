/** Asks TMDB, one title at a time, for the IMDb id of every stored TMDB title that has never been asked. */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { media, tracking } from '#lib/server/db/schema.js';
import type { createDb } from '#lib/server/db/index.js';
import { HYDRATABLE_PROVIDERS } from '#lib/sync/events.js';
import type { TmdbClient } from '#lib/server/tmdb/index.js';
import { writeExternalId } from './external-ids';
import { parseTmdbExternalId } from './hydrate';

type Db = ReturnType<typeof createDb>;
type TmdbAliasLookup = Pick<TmdbClient, 'externalIds'>;

/** One TMDB request per title, sequentially — a run's ceiling keeps a daily job from spending the whole day's request budget. */
export const IMDB_ALIAS_MAX = 200;

export interface ImdbAliasBackfillResult {
	/** Titles asked about this run; a floor on the real backlog once `capped` is true. */
	scanned: number;
	aliased: number;
	/** Asked and answered "no IMDb id" — stamped, so the next run doesn't ask again. */
	noId: number;
	/** Left unstamped, so the next run retries. */
	failed: number;
	capped: boolean;
}

export async function backfillImdbAliases(
	db: Db,
	tmdb: TmdbAliasLookup,
	now: number = Date.now(),
	max: number = IMDB_ALIAS_MAX
): Promise<ImdbAliasBackfillResult> {
	// `tracking` has no `media_id` index, so the "is it on someone's list" question is answered from one
	// deduped scan of the table rather than a correlated subquery per candidate.
	const tracked = db
		.selectDistinct({ mediaId: tracking.mediaId })
		.from(tracking)
		.where(eq(tracking.removed, false))
		.as('tracked');

	// Limited at the source, not sliced afterwards — an unbounded SELECT pulls the whole catalog into
	// Worker memory before the cap could engage. The `+ 1` makes overflow distinguishable from exhaustion.
	// `is null` sorts 0 before 1, so tracked titles come first; then oldest pull first.
	const rows = await db
		.select({ id: media.id, externalId: media.externalId })
		.from(media)
		.leftJoin(tracked, eq(tracked.mediaId, media.id))
		.where(and(isNull(media.imdbCheckedAt), inArray(media.provider, [...HYDRATABLE_PROVIDERS])))
		.orderBy(sql`${tracked.mediaId} is null`, asc(media.refreshedAt))
		.limit(max + 1);

	const batch = rows.slice(0, max);
	const capped = rows.length > batch.length;
	if (capped) {
		console.warn(
			`imdb-aliases: more than ${max} titles never asked, processing ${batch.length} this run`
		);
	}

	let aliased = 0;
	let noId = 0;
	let failed = 0;
	for (const row of batch) {
		const parsed = row.externalId === null ? null : parseTmdbExternalId(row.externalId);
		if (!parsed) {
			// A hydratable row always stores `movie|show/<id>`; anything else is corrupt and unanswerable,
			// so it stays unstamped and loud rather than being silently stamped as asked.
			console.error(`imdb-aliases: unparseable external id ${row.externalId} on ${row.id}`);
			failed++;
			continue;
		}
		try {
			const imdbId = await tmdb.externalIds(parsed.type, parsed.tmdbId);
			// Alias before stamp: a write that throws must leave the row unstamped so the next run retries.
			if (imdbId) await writeExternalId(db, row.id, 'imdb', imdbId);
			// No `version` bump: `imdb_checked_at` isn't client-visible, and a bump would force needless re-pulls.
			await db.update(media).set({ imdbCheckedAt: now }).where(eq(media.id, row.id));
			if (imdbId) aliased++;
			else noId++;
		} catch (err) {
			// One rate-limited title must not fail the batch; leaving it unstamped is what queues the retry.
			console.error(`imdb-aliases: externalIds failed for ${row.externalId}`, err);
			failed++;
		}
	}

	// One line per run, always — a run that stamped nothing would otherwise look identical to a healthy one.
	console.log(
		`imdb-aliases: batch of ${batch.length} — ${aliased} aliased, ` +
			`${noId} without an IMDb id, ${failed} failed`
	);

	return { scanned: batch.length, aliased, noId, failed, capped };
}
