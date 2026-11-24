/** A user's library as a paged snapshot. Every query is scoped to the one `userId` the caller passes in. */
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import { chunkIds } from '#lib/server/db/chunk.js';
import type { createDb } from '#lib/server/db/index.js';
import { episodeWatches, media, tracking } from '#lib/server/db/schema.js';
import type { MediaProvider, TrackingStatus } from '#lib/sync/events.js';

type Db = ReturnType<typeof createDb>;

/** Largest page a caller can ask for, and the default: the snapshot is read in bulk, not row by row. */
export const LIBRARY_PAGE_MAX = 100;

export interface LibraryMedia {
	id: string;
	provider: MediaProvider;
	externalId: string | null;
	type: 'movie' | 'show';
	title: string;
	year: number | null;
	posterPath: string | null;
}

/** Per-episode state of a show. `watched: false` rows are kept: an un-watch is a state, not an absence. */
export interface LibraryEpisode {
	season: number;
	episode: number;
	watched: boolean;
}

export interface LibraryEntry {
	tracking: {
		mediaId: string;
		status: TrackingStatus;
		favorite: boolean;
		rating: number | null;
		/** Tombstone: the title was removed, but the row has to stay visible so a reader can tell it was removed rather than never tracked. */
		removed: boolean;
		statusUpdatedAt: number;
		favoriteUpdatedAt: number;
		ratingUpdatedAt: number;
		removedUpdatedAt: number;
		/** Epoch ms of the earliest known add — the snapshot's sort key. */
		addedAt: number;
	};
	media: LibraryMedia;
	/** Null for movies. */
	episodes: LibraryEpisode[] | null;
}

export interface LibraryPage {
	entries: LibraryEntry[];
	/** Null when this is the last page. */
	nextCursor: string | null;
}

export class InvalidLibraryCursorError extends Error {
	constructor() {
		super('Invalid library cursor');
		this.name = 'InvalidLibraryCursorError';
	}
}

interface Cursor {
	addedAt: number;
	id: string;
}

/** Opaque to callers: both sort keys travel, so a page boundary between rows sharing a timestamp stays exact. */
function encodeCursor(cursor: Cursor): string {
	return btoa(`${cursor.addedAt}:${cursor.id}`)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

function decodeCursor(raw: string): Cursor {
	let decoded: string;
	try {
		decoded = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
	} catch {
		throw new InvalidLibraryCursorError();
	}
	const match = /^(\d{1,16}):(.+)$/.exec(decoded);
	if (!match) throw new InvalidLibraryCursorError();

	const addedAt = Number(match[1]);
	// Past Date's maximum this is an invalid Date, which binds as NULL: the query then matches no
	// rows and a caller reads the empty page as "this library is empty" rather than a bad cursor.
	if (!Number.isSafeInteger(addedAt) || addedAt > 8.64e15) throw new InvalidLibraryCursorError();
	return { addedAt, id: match[2] };
}

/** Tracking ⋈ media, the columns every read returns; `id` is the tracking row the page cursor orders by. */
type EntryRow = { id: string } & Pick<
	typeof tracking.$inferSelect,
	| 'mediaId'
	| 'status'
	| 'favorite'
	| 'rating'
	| 'removed'
	| 'statusUpdatedAt'
	| 'favoriteUpdatedAt'
	| 'ratingUpdatedAt'
	| 'removedUpdatedAt'
	| 'addedAt'
> &
	Pick<
		typeof media.$inferSelect,
		'type' | 'title' | 'year' | 'posterPath' | 'provider' | 'externalId'
	>;

/** One select shape for both reads, so a paged entry and a single entry can never drift apart. */
const entryColumns = {
	id: tracking.id,
	mediaId: tracking.mediaId,
	status: tracking.status,
	favorite: tracking.favorite,
	rating: tracking.rating,
	removed: tracking.removed,
	statusUpdatedAt: tracking.statusUpdatedAt,
	favoriteUpdatedAt: tracking.favoriteUpdatedAt,
	ratingUpdatedAt: tracking.ratingUpdatedAt,
	removedUpdatedAt: tracking.removedUpdatedAt,
	addedAt: tracking.addedAt,
	type: media.type,
	title: media.title,
	year: media.year,
	posterPath: media.posterPath,
	provider: media.provider,
	externalId: media.externalId
};

function toEntry(row: EntryRow, watches: LibraryEpisode[]): LibraryEntry {
	return {
		tracking: {
			mediaId: row.mediaId,
			status: row.status,
			favorite: row.favorite,
			rating: row.rating,
			removed: row.removed,
			statusUpdatedAt: row.statusUpdatedAt,
			favoriteUpdatedAt: row.favoriteUpdatedAt,
			ratingUpdatedAt: row.ratingUpdatedAt,
			removedUpdatedAt: row.removedUpdatedAt,
			addedAt: row.addedAt.getTime()
		},
		media: {
			id: row.mediaId,
			provider: row.provider,
			externalId: row.externalId,
			type: row.type,
			title: row.title,
			year: row.year,
			posterPath: row.posterPath
		},
		episodes:
			row.type === 'show'
				? watches
						.map(({ season, episode, watched }) => ({ season, episode, watched }))
						.sort((a, b) => a.season - b.season || a.episode - b.episode)
				: null
	};
}

/** Chunked because a page can reference more titles than one SQLite statement takes parameters. */
async function readWatches(db: Db, userId: string, mediaIds: string[]) {
	if (mediaIds.length === 0) return [];
	return (
		await Promise.all(
			chunkIds(mediaIds).map((ids) =>
				db
					.select({
						mediaId: episodeWatches.mediaId,
						season: episodeWatches.season,
						episode: episodeWatches.episode,
						watched: episodeWatches.watched
					})
					.from(episodeWatches)
					.where(and(eq(episodeWatches.userId, userId), inArray(episodeWatches.mediaId, ids)))
			)
		)
	).flat();
}

/**
 * One page of the user's library, newest add first, tie-broken by row id so a shared timestamp
 * can't make the cursor skip or repeat a row. `userId` must come from the authenticated token.
 */
export async function readLibraryPage(
	db: Db,
	userId: string,
	options: { cursor?: string | null; limit?: number } = {}
): Promise<LibraryPage> {
	const limit = Math.min(
		Math.max(1, Math.trunc(options.limit ?? LIBRARY_PAGE_MAX)),
		LIBRARY_PAGE_MAX
	);
	const cursor = options.cursor ? decodeCursor(options.cursor) : null;
	const after = cursor
		? or(
				lt(tracking.addedAt, new Date(cursor.addedAt)),
				and(eq(tracking.addedAt, new Date(cursor.addedAt)), lt(tracking.id, cursor.id))
			)
		: undefined;

	// Media is joined rather than looked up per row, and the `+ 1` row only proves another page exists.
	// Inner join drops a tracked id with no media row: there is nothing to render for it yet.
	const rows = await db
		.select(entryColumns)
		.from(tracking)
		.innerJoin(media, eq(media.id, tracking.mediaId))
		.where(and(eq(tracking.userId, userId), after))
		.orderBy(desc(tracking.addedAt), desc(tracking.id))
		.limit(limit + 1);

	const page = rows.slice(0, limit);
	const showIds = page.filter((row) => row.type === 'show').map((row) => row.mediaId);
	const watchRows = await readWatches(db, userId, showIds);

	const episodesByMedia = new Map<string, LibraryEpisode[]>();
	for (const watch of watchRows) {
		const list = episodesByMedia.get(watch.mediaId) ?? [];
		list.push({ season: watch.season, episode: watch.episode, watched: watch.watched });
		episodesByMedia.set(watch.mediaId, list);
	}

	const entries = page.map((row) => toEntry(row, episodesByMedia.get(row.mediaId) ?? []));

	const last = page.at(-1);
	return {
		entries,
		nextCursor:
			rows.length > limit && last
				? encodeCursor({ addedAt: last.addedAt.getTime(), id: last.id })
				: null
	};
}

/**
 * One entry, in the same shape a page returns, or null when the user does not track that title (yet).
 * `userId` must come from the authenticated token.
 */
export async function readLibraryEntry(
	db: Db,
	userId: string,
	mediaId: string
): Promise<LibraryEntry | null> {
	const [row] = await db
		.select(entryColumns)
		.from(tracking)
		.innerJoin(media, eq(media.id, tracking.mediaId))
		.where(and(eq(tracking.userId, userId), eq(tracking.mediaId, mediaId)))
		.limit(1);
	if (!row) return null;

	const watches = row.type === 'show' ? await readWatches(db, userId, [row.mediaId]) : [];
	return toEntry(row, watches);
}
