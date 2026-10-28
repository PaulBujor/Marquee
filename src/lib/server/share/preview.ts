/**
 * Share previews: the small catalogue-only snapshot a public shared link renders from.
 *
 * *Warming* one is the only path that reaches TMDB for a share, and it requires an authenticated
 * account, so a crawler following a shared link can never spend provider quota; the public read
 * path (`readPreview`) touches D1 only. Warming is idempotent per title/person — re-warming
 * refreshes the same row — and capped per account so one session can't enumerate the catalogue.
 */
import { and, count, eq, gte, lt } from 'drizzle-orm';
import { createTmdbClient, TmdbError } from '$lib/server/tmdb';
import { sharePreviewWarms, sharePreviews, type SharePreviewRow } from '$lib/server/db/schema';
import type { createDb } from '$lib/server/db';

type Db = ReturnType<typeof createDb>;

/** Warm requests one account may make per hour — comfortably above real browsing. */
export const WARM_MAX_PER_HOUR = 60;
const WARM_WINDOW_MS = 60 * 60 * 1000;
/** Warm rows exist only to count requests, so they're swept once past every window that reads them. */
const WARM_RETENTION_MS = 24 * 60 * 60 * 1000;
/** A person's preview carries the opening of their biography, not the biography. */
const SUMMARY_MAX = 400;
export const KNOWN_FOR_MAX = 3;

export interface TitlePreview {
	kind: 'title';
	type: 'movie' | 'show';
	externalId: number;
	name: string;
	year: number | null;
	summary: string | null;
	imagePath: string | null;
	updatedAt: number;
}

export interface PersonPreview {
	kind: 'person';
	externalId: number;
	name: string;
	summary: string | null;
	imagePath: string | null;
	knownFor: string[];
	updatedAt: number;
}

export type SharePreview = TitlePreview | PersonPreview;

export type WarmResult =
	| { kind: 'warmed'; preview: SharePreview }
	| { kind: 'rate_limited' }
	| { kind: 'not_found' }
	| { kind: 'unavailable' };

const PROVIDER = 'tmdb' as const;

/** The primary key: provider first, so a second provider can't collide with a TMDB id. */
export function previewId(kind: 'title' | 'person', externalId: number): string {
	return `${PROVIDER}:${kind}:${externalId}`;
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

/** Warm a title's preview. `now` is injectable so the cap can be tested without waiting. */
export async function warmTitlePreview(
	db: Db,
	apiKey: string,
	opts: { userId: string; type: 'movie' | 'show'; id: number; now?: number }
): Promise<WarmResult> {
	if (!isValidExternalId(opts.id)) return { kind: 'not_found' };
	const now = opts.now ?? Date.now();
	if ((await countRecentWarms(db, opts.userId, now)) >= WARM_MAX_PER_HOUR)
		return { kind: 'rate_limited' };

	try {
		const detail = await createTmdbClient(apiKey).getDetails(opts.type, opts.id);
		const preview: TitlePreview = {
			kind: 'title',
			type: opts.type,
			externalId: opts.id,
			name: detail.title,
			year: detail.year,
			summary: detail.overview,
			imagePath: detail.posterPath,
			updatedAt: now
		};
		await db.batch([upsertPreview(db, preview), recordWarm(db, opts.userId, now)]);
		return { kind: 'warmed', preview };
	} catch (err) {
		return warmFailure('title', err);
	}
}

/** Warm a person's preview: name, photo and up to three "known for" lines. */
export async function warmPersonPreview(
	db: Db,
	apiKey: string,
	opts: { userId: string; id: number; now?: number }
): Promise<WarmResult> {
	if (!isValidExternalId(opts.id)) return { kind: 'not_found' };
	const now = opts.now ?? Date.now();
	if ((await countRecentWarms(db, opts.userId, now)) >= WARM_MAX_PER_HOUR)
		return { kind: 'rate_limited' };

	try {
		const page = await createTmdbClient(apiKey).getPerson(opts.id, 1);
		const preview: PersonPreview = {
			kind: 'person',
			externalId: opts.id,
			name: page.person.name,
			summary: page.person.biography.slice(0, SUMMARY_MAX).trim(),
			imagePath: page.person.profilePath,
			knownFor: page.credits.slice(0, KNOWN_FOR_MAX).map(knownForLine),
			updatedAt: now
		};
		await db.batch([upsertPreview(db, preview), recordWarm(db, opts.userId, now)]);
		return { kind: 'warmed', preview };
	} catch (err) {
		return warmFailure('person', err);
	}
}

/** Read a warmed preview. D1 only — this is the public read path's entire data access. */
export async function readPreview(
	db: Db,
	kind: 'title' | 'person',
	externalId: number
): Promise<SharePreview | null> {
	if (!isValidExternalId(externalId)) return null;
	const row = (
		await db
			.select()
			.from(sharePreviews)
			.where(eq(sharePreviews.id, previewId(kind, externalId)))
			.limit(1)
	).at(0);
	return row ? toPreview(row) : null;
}

/** Delete warm rows past retention, so the counter table can't grow unbounded. */
export async function purgeSharePreviewWarms(db: Db, now: number = Date.now()): Promise<number> {
	const removed = await db
		.delete(sharePreviewWarms)
		.where(lt(sharePreviewWarms.createdAt, new Date(now - WARM_RETENTION_MS)))
		.returning({ id: sharePreviewWarms.id });
	return removed.length;
}

/** An unknown id is `not_found`; any other provider failure is `unavailable` (the caller decides). */
function warmFailure(what: 'title' | 'person', err: unknown): WarmResult {
	if (err instanceof TmdbError) {
		if (err.status === 404) return { kind: 'not_found' };
		console.error(`share preview: TMDB ${what} warm failed`, err.status, err.message);
		return { kind: 'unavailable' };
	}
	throw err;
}

function recordWarm(db: Db, userId: string, now: number) {
	return db
		.insert(sharePreviewWarms)
		.values({ id: crypto.randomUUID(), userId, createdAt: new Date(now) });
}

function upsertPreview(db: Db, preview: SharePreview) {
	const values = {
		id: previewId(preview.kind, preview.externalId),
		kind: preview.kind,
		provider: PROVIDER,
		externalId: String(preview.externalId),
		titleType: preview.kind === 'title' ? preview.type : null,
		name: preview.name,
		year: preview.kind === 'title' ? preview.year : null,
		summary: preview.summary,
		imagePath: preview.imagePath,
		knownFor: preview.kind === 'person' ? JSON.stringify(preview.knownFor) : null,
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
				knownFor: values.knownFor,
				updatedAt: values.updatedAt
			}
		});
}

/** `Title (1999)` — a credit line the card can print as-is. */
function knownForLine(credit: { title: string; year: number | null }): string {
	return credit.year ? `${credit.title} (${credit.year})` : credit.title;
}

function toPreview(row: SharePreviewRow): SharePreview {
	const updatedAt = row.updatedAt.getTime();
	if (row.kind === 'person') {
		return {
			kind: 'person',
			externalId: Number(row.externalId),
			name: row.name,
			summary: row.summary,
			imagePath: row.imagePath,
			knownFor: parseKnownFor(row.knownFor),
			updatedAt
		};
	}
	return {
		kind: 'title',
		type: row.titleType === 'movie' ? 'movie' : 'show',
		externalId: Number(row.externalId),
		name: row.name,
		year: row.year,
		summary: row.summary,
		imagePath: row.imagePath,
		updatedAt
	};
}

function parseKnownFor(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((line): line is string => typeof line === 'string')
			: [];
	} catch {
		return [];
	}
}
