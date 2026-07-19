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

// --- Detail (`/movie/{id}` & `/tv/{id}` with `append_to_response=credits,images,videos`) ---

/** A genre entry on a detail response. */
export interface TmdbGenre {
	id: number;
	name: string;
}

/** A cast member from the appended `credits`. TMDB pre-orders `cast` by billing. */
export interface TmdbCastMember {
	id: number;
	name: string;
	character?: string;
	profile_path?: string | null;
	order?: number;
}

/** The appended `credits` object (only `cast` is consumed). */
export interface TmdbCredits {
	cast?: TmdbCastMember[];
}

/** A video from the appended `videos` (trailers, teasers, clips…). */
export interface TmdbVideo {
	key: string;
	name: string;
	site: string;
	type: string;
	official?: boolean;
}

/** The appended `videos` object. */
export interface TmdbVideosResponse {
	results?: TmdbVideo[];
}

/** A single image file from the appended `images`. */
export interface TmdbImage {
	file_path: string;
}

/** The appended `images` object. */
export interface TmdbImages {
	backdrops?: TmdbImage[];
	posters?: TmdbImage[];
}

/** Raw `/movie/{id}` detail response (only consumed fields modelled). */
export interface TmdbMovieDetailsResponse {
	id: number;
	title?: string;
	release_date?: string;
	overview?: string;
	poster_path?: string | null;
	backdrop_path?: string | null;
	vote_average?: number;
	vote_count?: number;
	runtime?: number | null;
	genres?: TmdbGenre[];
	credits?: TmdbCredits;
	images?: TmdbImages;
	videos?: TmdbVideosResponse;
}

/** Raw `/tv/{id}` detail response (only consumed fields modelled). */
export interface TmdbTvDetailsResponse {
	id: number;
	name?: string;
	first_air_date?: string;
	overview?: string;
	poster_path?: string | null;
	backdrop_path?: string | null;
	vote_average?: number;
	vote_count?: number;
	episode_run_time?: number[];
	genres?: TmdbGenre[];
	credits?: TmdbCredits;
	images?: TmdbImages;
	videos?: TmdbVideosResponse;
	seasons?: TmdbSeasonSummary[];
}

/** A season summary from a `/tv/{id}` response (TMDB includes season 0 = "Specials"). */
export interface TmdbSeasonSummary {
	season_number: number;
	name?: string;
	overview?: string;
	air_date?: string;
	episode_count?: number;
	poster_path?: string | null;
}

/** A single episode from a `/tv/{id}/season/{n}` response. */
export interface TmdbEpisode {
	episode_number: number;
	name?: string;
	overview?: string;
	air_date?: string;
	still_path?: string | null;
	runtime?: number | null;
}

/** Raw `/tv/{id}/season/{n}` response (only consumed fields modelled). */
export interface TmdbSeasonDetailResponse {
	season_number: number;
	name?: string;
	overview?: string;
	episodes?: TmdbEpisode[];
}

/** A normalized cast member for the detail UI. */
export interface CastMember {
	id: number;
	name: string;
	character: string;
	profilePath: string | null;
}

/** A normalized YouTube trailer (its `key` is the YouTube video id). */
export interface MediaTrailer {
	key: string;
	name: string;
}

/** Normalized, app-facing media detail — the shape the detail page sees. */
export interface MediaDetail {
	tmdbId: number;
	type: 'movie' | 'show';
	title: string;
	/** Release / first-air year, or null when TMDB has no date. */
	year: number | null;
	overview: string;
	posterPath: string | null;
	backdropPath: string | null;
	/** TMDB vote average (0–10), or null when unrated. */
	rating: number | null;
	voteCount: number;
	/** Runtime in minutes (movie runtime, or first TV episode run time), or null. */
	runtime: number | null;
	genres: string[];
	cast: CastMember[];
	trailer: MediaTrailer | null;
	/** Season summaries for shows (ordered as TMDB returns them); empty for movies. */
	seasons: Season[];
}

/** A normalized season summary for the detail page's season selector. */
export interface Season {
	seasonNumber: number;
	name: string;
	episodeCount: number;
	/** Air year, or null when TMDB has no date. */
	airYear: number | null;
	posterPath: string | null;
	overview: string;
}

/** A normalized episode for the season episode list. */
export interface Episode {
	episodeNumber: number;
	name: string;
	/** Raw TMDB air date (`YYYY-MM-DD`), or null. */
	airDate: string | null;
	overview: string;
	stillPath: string | null;
	/** Episode runtime in minutes, or null when TMDB has none. */
	runtime: number | null;
}

/** A normalized single season with its episodes (`/tv/{id}/season/{n}`). */
export interface SeasonDetail {
	seasonNumber: number;
	name: string;
	episodes: Episode[];
}
