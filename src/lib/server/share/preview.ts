/**
 * Share previews: the catalogue-only snapshot a public shared link renders from. Warming is the only
 * path that reaches TMDB for a share and needs a session, so a crawler spends no provider quota; the
 * read path touches D1 only. Warming is idempotent, and capped per account.
 */
import { and, count, eq, gte, lt } from 'drizzle-orm';
import { createTmdbClient, TmdbError, type MediaDetail } from '$lib/server/tmdb';
import { sharePreviewWarms, sharePreviews, type SharePreviewRow } from '$lib/server/db/schema';
import { productionState, seasonCount } from '$lib/tracking/actions';
import type { createDb } from '$lib/server/db';
import type { CastCredit, CrewCredits, SharePreview } from '$lib/share-preview';

type Db = ReturnType<typeof createDb>;

/** Warm requests one account may make per hour — comfortably above real browsing. */
export const WARM_MAX_PER_HOUR = 60;
const WARM_WINDOW_MS = 60 * 60 * 1000;
/** Warm rows exist only to count requests, so they're swept once past every window that reads them. */
const WARM_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Preview rows are catalogue cache for links people may re-open, so they outlive the warm rows. */
const PREVIEW_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** A warm younger than this isn't worth a provider call; re-opening a link shouldn't cost TMDB. */
const PREVIEW_FRESH_MS = 12 * 60 * 60 * 1000;

export type WarmResult =
	| { kind: 'warmed'; preview: SharePreview }
	| { kind: 'rate_limited' }
	| { kind: 'not_found' }
	| { kind: 'unavailable' };

const PROVIDER = 'tmdb' as const;

/** The primary key: provider and type first, because a movie id and a show id are different titles. */
export function previewId(type: 'movie' | 'show', externalId: number): string {
	return `${PROVIDER}:${type}:${externalId}`;
}

/** Positive integers only — the value arrives from the client and ends up in a TMDB path. */
export function isValidExternalId(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export async function countRecentWarms(db: Db, userId: string, now: number): Promise<number> {
	const rows = await db
		.select({ total: count() })
		.from(sharePreviewWarms)
		.where(
			and(
				eq(sharePreviewWarms.userId, userId),
				gte(sharePreviewWarms.createdAt, new Date(now - WARM_WINDOW_MS))
			)
		);
	return rows.at(0)?.total ?? 0;
}

export async function warmTitlePreview(
	db: Db,
	apiKey: string,
	opts: { userId: string; type: 'movie' | 'show'; id: number; now?: number }
): Promise<WarmResult> {
	if (!isValidExternalId(opts.id)) return { kind: 'not_found' };
	const now = opts.now ?? Date.now();

	// A stored preview this fresh is what a warm would produce anyway, so don't spend a provider call
	// on it — re-opening a shared link shouldn't cost TMDB anything.
	const stored = await readPreview(db, opts.type, opts.id);
	if (stored && now - stored.updatedAt < PREVIEW_FRESH_MS)
		return { kind: 'warmed', preview: stored };

	// Counted, then inserted, so concurrent requests can overshoot by however many are in flight:
	// this is a limit against enumeration, not a hard quota.
	if ((await countRecentWarms(db, opts.userId, now)) >= WARM_MAX_PER_HOUR)
		return { kind: 'rate_limited' };

	// Counted before the provider call: a failing provider is exactly when the cap has to bite, and
	// counting only successes would hand out unlimited retries while TMDB is down.
	await recordWarm(db, opts.userId, now);

	try {
		const detail = await createTmdbClient(apiKey).getDetails(opts.type, opts.id);
		const preview = toPreviewShape(detail, now);
		await upsertPreview(db, preview);
		return { kind: 'warmed', preview };
	} catch (err) {
		if (err instanceof TmdbError) {
			if (err.status === 404) return { kind: 'not_found' };
			console.error('share preview: TMDB warm failed', err.status, err.message);
			return { kind: 'unavailable' };
		}
		throw err;
	}
}

/** Read a warmed preview. D1 only — this is the public read path's entire data access. */
export async function readPreview(
	db: Db,
	type: 'movie' | 'show',
	externalId: number
): Promise<SharePreview | null> {
	if (!isValidExternalId(externalId)) return null;
	const row = (
		await db
			.select()
			.from(sharePreviews)
			.where(eq(sharePreviews.id, previewId(type, externalId)))
			.limit(1)
	).at(0);
	return row ? fromRow(row) : null;
}

export async function purgeSharePreviewWarms(db: Db, now: number = Date.now()): Promise<number> {
	const removed = await db
		.delete(sharePreviewWarms)
		.where(lt(sharePreviewWarms.createdAt, new Date(now - WARM_RETENTION_MS)))
		.returning({ id: sharePreviewWarms.id });
	return removed.length;
}

export async function purgeSharePreviews(db: Db, now: number = Date.now()): Promise<number> {
	const removed = await db
		.delete(sharePreviews)
		.where(lt(sharePreviews.updatedAt, new Date(now - PREVIEW_RETENTION_MS)))
		.returning({ id: sharePreviews.id });
	return removed.length;
}

function toPreviewShape(detail: MediaDetail, now: number): SharePreview {
	return {
		type: detail.type,
		externalId: detail.tmdbId,
		name: detail.title,
		year: detail.year,
		summary: detail.overview,
		imagePath: detail.posterPath,
		backdropPath: detail.backdropPath,
		rating: detail.rating,
		runtime: detail.runtime,
		releasedOn: detail.type === 'movie' ? detail.releaseDate : detail.firstAirDate,
		seasons: detail.type === 'show' ? seasonCount(detail.seasons) : 0,
		production:
			detail.type === 'show' && productionState(detail.inProduction) !== 'unknown'
				? (productionState(detail.inProduction) as 'in_production' | 'ended')
				: null,
		genres: detail.genres,
		crew: crewOf(detail),
		// The TMDB client already trims cast to what the app's own page shows.
		cast: detail.cast.map((member) => ({
			name: member.name,
			profilePath: member.profilePath
		})),
		updatedAt: now
	};
}

function crewOf(detail: MediaDetail): CrewCredits {
	return {
		director: detail.director?.name ?? null,
		creators: detail.creators.map((member) => member.name),
		writers: detail.writers.map((member) => member.name),
		producers: detail.producers.map((member) => member.name)
	};
}

function recordWarm(db: Db, userId: string, now: number) {
	return db
		.insert(sharePreviewWarms)
		.values({ id: crypto.randomUUID(), userId, createdAt: new Date(now) });
}

function upsertPreview(db: Db, preview: SharePreview) {
	const values = {
		id: previewId(preview.type, preview.externalId),
		provider: PROVIDER,
		externalId: String(preview.externalId),
		titleType: preview.type,
		name: preview.name,
		year: preview.year,
		summary: preview.summary,
		imagePath: preview.imagePath,
		backdropPath: preview.backdropPath,
		rating: preview.rating,
		runtime: preview.runtime,
		releasedOn: preview.releasedOn,
		seasons: preview.seasons,
		production: preview.production,
		genres: JSON.stringify(preview.genres),
		crew: JSON.stringify(preview.crew),
		cast: JSON.stringify(preview.cast),
		updatedAt: new Date(preview.updatedAt)
	};
	return db
		.insert(sharePreviews)
		.values(values)
		.onConflictDoUpdate({
			target: sharePreviews.id,
			set: {
				name: values.name,
				year: values.year,
				summary: values.summary,
				imagePath: values.imagePath,
				backdropPath: values.backdropPath,
				rating: values.rating,
				runtime: values.runtime,
				releasedOn: values.releasedOn,
				seasons: values.seasons,
				production: values.production,
				genres: values.genres,
				crew: values.crew,
				cast: values.cast,
				updatedAt: values.updatedAt
			}
		});
}

function fromRow(row: SharePreviewRow): SharePreview {
	return {
		type: row.titleType,
		externalId: Number(row.externalId),
		name: row.name,
		year: row.year,
		summary: row.summary,
		imagePath: row.imagePath,
		backdropPath: row.backdropPath,
		rating: row.rating,
		runtime: row.runtime,
		releasedOn: isIsoDate(row.releasedOn) ? row.releasedOn : null,
		seasons: row.seasons ?? 0,
		production: row.production,
		genres: parseList<string>(row.genres),
		crew: parseCrew(row.crew),
		cast: parseList<CastCredit>(row.cast),
		updatedAt: row.updatedAt.getTime()
	};
}

/** A `YYYY-MM-DD` date or nothing: the page formats what it is given, and `Intl` throws on junk. */
function isIsoDate(value: string | null): value is string {
	return typeof value === 'string' && value.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** JSON columns are written by us, but a hand-edited row shouldn't be able to break a page. */
function parseList<T>(value: string | null): T[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? (parsed as T[]) : [];
	} catch {
		return [];
	}
}

function parseCrew(value: string | null): CrewCredits {
	const empty: CrewCredits = { director: null, creators: [], writers: [], producers: [] };
	if (!value) return empty;
	try {
		const parsed = JSON.parse(value) as Partial<CrewCredits>;
		return {
			director: parsed.director ?? null,
			creators: parsed.creators ?? [],
			writers: parsed.writers ?? [],
			producers: parsed.producers ?? []
		};
	} catch {
		return empty;
	}
}
