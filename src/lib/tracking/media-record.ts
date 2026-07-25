import { tmdbExternalId, tmdbMediaId, type MediaRecord } from '$lib/sync/events';

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
 * the detail page (MRQ-125). We only know the scalars TMDB puts on a search row; the rest is
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
		episodes: null
	};
}
