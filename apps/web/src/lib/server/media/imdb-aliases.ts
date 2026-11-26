/** Producer selects + enqueues; the queue consumer makes the one TMDB request per title. */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { media, tracking } from '#lib/server/db/schema.js';
import type { createDb } from '#lib/server/db/index.js';
import { HYDRATABLE_PROVIDERS } from '#lib/sync/events.js';
import type { MediaProvider } from '#lib/sync/events.js';
import type { TmdbClient } from '#lib/server/tmdb/index.js';
import { TmdbError } from '#lib/server/tmdb/client.js';
import type { QueueEnvelope, QueueOutcome, QueueProducer } from '#lib/server/queue/types.js';
import { writeExternalId } from './external-ids';
import { MAX_DELIVERY_ATTEMPTS } from './refresh-consumer';
import { parseTmdbExternalId } from './hydrate';

type Db = ReturnType<typeof createDb>;
type TmdbAliasLookup = Pick<TmdbClient, 'externalIds'>;

/** A generous backstop, not a budget: enqueueing is a D1 read plus cheap queue sends, no TMDB round-trip. */
export const IMDB_ALIAS_MAX = 5000;

export interface ImdbAliasMessage {
	mediaId: string;
	provider: MediaProvider;
	externalId: string;
}

export interface EnqueueImdbAliasResult {
	/** Bounded by the cap, so a floor on the real population once `capped` is true. */
	scanned: number;
	queued: number;
	capped: boolean;
}

export async function enqueueImdbAliasCandidates(
	db: Db,
	queue: QueueProducer<ImdbAliasMessage>,
	max: number = IMDB_ALIAS_MAX
): Promise<EnqueueImdbAliasResult> {
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
		.select({ id: media.id, provider: media.provider, externalId: media.externalId })
		.from(media)
		.leftJoin(tracked, eq(tracked.mediaId, media.id))
		.where(and(isNull(media.imdbCheckedAt), inArray(media.provider, [...HYDRATABLE_PROVIDERS])))
		.orderBy(sql`${tracked.mediaId} is null`, asc(media.refreshedAt))
		.limit(max + 1);

	const batch = rows.slice(0, max);
	const capped = rows.length > batch.length;
	if (capped) {
		console.warn(
			`imdb-aliases: more than ${max} titles never asked, enqueueing ${batch.length} this run`
		);
	}

	// A null external id is unanswerable, so it stays unstamped and unqueued rather than looping forever.
	const messages: ImdbAliasMessage[] = batch.flatMap((row) =>
		row.externalId === null
			? []
			: [{ mediaId: row.id, provider: row.provider, externalId: row.externalId }]
	);
	await queue.enqueueBatch(messages);

	return { scanned: rows.length, queued: messages.length, capped };
}

export async function processImdbAliasBatch(
	db: Db,
	tmdb: TmdbAliasLookup,
	envelopes: QueueEnvelope<ImdbAliasMessage>[],
	now: number = Date.now()
): Promise<QueueOutcome[]> {
	const outcomes: QueueOutcome[] = [];
	let aliased = 0;
	let noId = 0;
	let gone = 0;
	let retrying = 0;
	let dropped = 0;
	for (const envelope of envelopes) {
		const { mediaId, externalId } = envelope.body;
		const parsed = parseTmdbExternalId(externalId);
		if (!parsed) {
			// A hydratable row always stores `movie|show/<id>`; anything else is corrupt and unanswerable,
			// so it is dropped loudly rather than retried forever.
			console.error(`imdb-aliases: unparseable external id ${externalId} on ${mediaId}`);
			outcomes.push('ack');
			dropped++;
			continue;
		}
		try {
			const imdbId = await tmdb.externalIds(parsed.type, parsed.tmdbId);
			// Alias before stamp: a write that throws must leave the row unstamped so the next run retries.
			if (imdbId) await writeExternalId(db, mediaId, 'imdb', imdbId);
			// No `version` bump: `imdb_checked_at` isn't client-visible, and a bump would force needless re-pulls.
			await db.update(media).set({ imdbCheckedAt: now }).where(eq(media.id, mediaId));
			outcomes.push('ack');
			if (imdbId) aliased++;
			else noId++;
		} catch (err) {
			// A 404 means the title is not on TMDB at all, so the question was answered: stamp it rather
			// than re-enqueueing a dead id every night and failing five times a day forever.
			if (err instanceof TmdbError && err.status === 404) {
				await db.update(media).set({ imdbCheckedAt: now }).where(eq(media.id, mediaId));
				console.warn(`imdb-aliases: ${externalId} is not on TMDB, stamped instead of retried`);
				outcomes.push('ack');
				gone++;
				continue;
			}
			const giveUp = envelope.attempts >= MAX_DELIVERY_ATTEMPTS;
			// Leaving the row unstamped is what queues the retry; one rate-limited title must not fail the batch.
			console.error(
				`imdb-aliases: externalIds failed for ${externalId} ` +
					`(attempt ${envelope.attempts}${giveUp ? ', giving up' : ', will retry'})`,
				err
			);
			outcomes.push(giveUp ? 'ack' : 'retry');
			if (giveUp) dropped++;
			else retrying++;
		}
	}
	// One line per batch, always — a queue acking nothing but no-ops would look healthy from the enqueue-side log alone.
	console.log(
		`imdb-aliases queue: batch of ${envelopes.length} — ${aliased} aliased, ` +
			`${noId} without an IMDb id, ${gone} gone from TMDB, ` +
			`${retrying} retrying, ${dropped} dropped`
	);
	return outcomes;
}
