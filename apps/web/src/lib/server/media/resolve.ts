/**
 * The one path from an external id to a media id we can act on: an alias if one is stored, otherwise a
 * hydrate that stores it. A miss is never filled in by deriving an id — that id names nobody.
 */
import { resolveMediaId } from './external-ids';
import { parseTmdbExternalId, refreshMedia } from './hydrate';
import type { createDb } from '#lib/server/db/index.js';
import type { TmdbClient } from '#lib/server/tmdb/index.js';

type Db = ReturnType<typeof createDb>;
type TmdbResolver = Pick<TmdbClient, 'findByExternalId' | 'getDetails' | 'getSeason'>;

/**
 * Either our media id, or `unresolved`: the id names no single title we could act on (TMDB has never
 * heard of it, or answers with more than one). A TMDB *failure* throws instead, because "no such
 * title" and "ask again later" are different answers to a caller.
 */
export type ResolveMediaResult = { mediaId: string } | { unresolved: true };

const UNRESOLVED: ResolveMediaResult = { unresolved: true };

/**
 * `externalId` is either an IMDb id (`tt…`, looked up in TMDB) or our own `<type>/<id>` form; `type` is
 * what the caller declares it is, and an answer of the other type is refused rather than adopted.
 */
export async function resolveMediaIdOrHydrate(
	db: Db,
	tmdb: TmdbResolver,
	{ type, externalId }: { type: 'movie' | 'show'; externalId: string }
): Promise<ResolveMediaResult> {
	if (!externalId) return UNRESOLVED;

	const parsed = parseTmdbExternalId(externalId);
	if (parsed) {
		if (parsed.type !== type) return UNRESOLVED;
		const stored = await resolveMediaId(db, 'tmdb', externalId);
		return stored ? { mediaId: stored } : hydrate(db, tmdb, externalId);
	}

	const alias = await resolveMediaId(db, 'imdb', externalId);
	if (alias) return { mediaId: alias };

	const found = await tmdb.findByExternalId(externalId);
	const ids = type === 'movie' ? found.movieIds : found.showIds;
	const otherType = type === 'movie' ? found.showIds : found.movieIds;
	// Exactly one title of the declared type and none of the other: anything else is a guess.
	if (ids.length !== 1 || otherType.length > 0) return UNRESOLVED;

	return hydrate(db, tmdb, `${type}/${ids[0]}`);
}

/** `refreshMedia` writes both the TMDB and the IMDb alias, so the next resolve of the same id is a plain hit. */
async function hydrate(
	db: Db,
	tmdb: TmdbResolver,
	externalId: string
): Promise<ResolveMediaResult> {
	const row = await refreshMedia(db, tmdb, 'tmdb', externalId);
	return row ? { mediaId: row.id } : UNRESOLVED;
}
