import { tmdbExternalId, tmdbMediaId, type MediaRecord } from '$lib/sync/events';

/** Split a TMDB external id (`movie/27205`) into its parts, or null if unparseable. */
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

/** Minimal MediaRecord from a search result for a quick add. `version: 0` so the channel pulls the real copy. */
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
		credits: null
	};
}
