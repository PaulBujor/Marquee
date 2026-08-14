import { tmdbExternalId, tmdbMediaId, type MediaRecord } from '$lib/sync/events';

/**
 * Split a TMDB external id (`movie/27205`) back into its parts, or null when it isn't one we could
 * address a title with. The inverse of {@link tmdbExternalId} — used wherever a stored external id
 * has to become a TMDB request or a detail-page route.
 */
export function parseTmdbExternalId(
	externalId: string
): { type: 'movie' | 'show'; tmdbId: number } | null {
	const [type, rest] = externalId.split('/');
	if (type !== 'movie' && type !== 'show') return null;
	// Reject anything Number() would coerce loosely (empty, floats, signs, whitespace).
	if (!/^\d+$/.test(rest ?? '')) return null;
	const tmdbId = Number(rest);
	if (tmdbId <= 0) return null;
	return { type, tmdbId };
}

/** The minimal fields a search result carries — enough to seed a media snapshot for a quick add. */
export interface SearchLikeMedia {
	tmdbId: number;
	type: 'movie' | 'show';
	title: string;
	year: number | null;
	posterPath: string | null;
	overview?: string;
}

/**
 * Build a minimal {@link MediaRecord} from a search result, for a quick add-to-list without opening
 * the detail page. We only know the scalars TMDB puts on a search row; the rest is
 * null/empty and `version: 0` marks the row behind, so the media channel pulls the authoritative
 * copy (backdrop, genres, seasons/episodes, air dates) on the next sync — same contract the detail
 * page's snapshot uses.
 */
export function mediaRecordFromSearch(item: SearchLikeMedia): MediaRecord {
	return {
		id: tmdbMediaId(item.type, item.tmdbId),
		provider: 'tmdb',
		externalId: tmdbExternalId(item.type, item.tmdbId),
		source: 'linked',
		type: item.type,
		title: item.title,
		year: item.year,
		posterPath: item.posterPath,
		backdropPath: null,
		overview: item.overview ?? '',
		genres: [],
		releaseDate: null,
		status: null,
		inProduction: null,
		firstAirDate: null,
		lastAirDate: null,
		version: 0,
		seasons: null,
		episodes: null,
		// A search row carries no cast; null (not []) so the snapshot can't blank credits the
		// channel already synced for this title.
		credits: null
	};
}
