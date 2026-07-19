/** Types for the TMDB client. Only the fields the app consumes are modelled. */

/** A single row from TMDB `/search/multi` (movies, tv, and people mixed). */
export interface TmdbMultiSearchItem {
	id: number;
	media_type: 'movie' | 'tv' | 'person';
	// movie titles
	title?: string;
	release_date?: string;
	// tv titles
	name?: string;
	first_air_date?: string;
	poster_path?: string | null;
	overview?: string;
}

export interface TmdbMultiSearchResponse {
	page: number;
	results: TmdbMultiSearchItem[];
	total_pages: number;
	total_results: number;
}

/** Normalized, app-facing search result — the only media shape the UI sees. */
export interface MediaSearchResult {
	tmdbId: number;
	type: 'movie' | 'show';
	title: string;
	/** Release / first-air year, or null when TMDB has no date. */
	year: number | null;
	posterPath: string | null;
	overview: string;
}
