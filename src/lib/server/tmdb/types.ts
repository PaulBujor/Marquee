/** Types for the TMDB client. Only the fields the app consumes are modelled. */

/** A single row from TMDB `/search/multi` (movies, tv, and people mixed). */
export interface TmdbMultiSearchItem {
	id: number;
	media_type: 'movie' | 'tv' | 'person';
	// movie titles
	title?: string;
	release_date?: string;
	// tv titles (`name` is also the person's name)
	name?: string;
	first_air_date?: string;
	poster_path?: string | null;
	overview?: string;
	// people
	profile_path?: string | null;
	known_for_department?: string;
	known_for?: Array<{ title?: string; name?: string }>;
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
	year: number | null;
	posterPath: string | null;
	overview: string;
}

export interface PersonSearchResult {
	tmdbId: number;
	name: string;
	profilePath: string | null;
	/** What TMDB considers their main line of work — "Acting", "Directing", "Production"… */
	department: string | null;
	knownFor: string[];
}

/** One relevance-ordered list — TMDB ranks people alongside films, so a director can outrank their own movies. */
export type SearchResult =
	({ kind: 'media' } & MediaSearchResult) | ({ kind: 'person' } & PersonSearchResult);

/** Same shape as a multi-search row but with no `media_type` — the endpoint implies it. */
export interface TmdbSimilarItem {
	id: number;
	title?: string;
	release_date?: string;
	name?: string;
	first_air_date?: string;
	poster_path?: string | null;
	overview?: string;
}

export interface TmdbSimilarResponse {
	results?: TmdbSimilarItem[];
}

// --- Detail (`/movie/{id}` & `/tv/{id}` with `append_to_response=credits,images,videos,recommendations,similar`) ---

export interface TmdbGenre {
	id: number;
	name: string;
}

/** TMDB pre-orders `cast` by billing. */
export interface TmdbCastMember {
	id: number;
	name: string;
	character?: string;
	profile_path?: string | null;
	order?: number;
}

export interface TmdbCrewMember {
	id: number;
	name: string;
	job?: string;
	department?: string;
	profile_path?: string | null;
}

export interface TmdbCredits {
	cast?: TmdbCastMember[];
	crew?: TmdbCrewMember[];
}

export interface TmdbVideo {
	key: string;
	name: string;
	site: string;
	type: string;
	official?: boolean;
}

export interface TmdbVideosResponse {
	results?: TmdbVideo[];
}

export interface TmdbImage {
	file_path: string;
}

export interface TmdbImages {
	backdrops?: TmdbImage[];
	posters?: TmdbImage[];
}

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
	recommendations?: TmdbSimilarResponse;
	similar?: TmdbSimilarResponse;
}

export interface TmdbTvDetailsResponse {
	id: number;
	name?: string;
	first_air_date?: string;
	last_air_date?: string;
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
	recommendations?: TmdbSimilarResponse;
	similar?: TmdbSimilarResponse;
	seasons?: TmdbSeasonSummary[];
	/** One of TMDB's TV statuses: `Returning Series`, `Planned`, `In Production`, `Ended`, `Canceled`, `Pilot`. */
	status?: string;
	in_production?: boolean;
	/** Series creators — the show equivalent of a film's director/writer; per-episode crew isn't fetched. */
	created_by?: { id: number; name: string }[];
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

export interface TmdbEpisode {
	episode_number: number;
	name?: string;
	overview?: string;
	air_date?: string;
	still_path?: string | null;
	runtime?: number | null;
}

export interface TmdbSeasonDetailResponse {
	season_number: number;
	name?: string;
	overview?: string;
	episodes?: TmdbEpisode[];
}

// --- Person (`/person/{id}` with `append_to_response=combined_credits`) ---

/** Mixed cast and crew rows: `cast` rows carry `character`, `crew` rows carry `job`. */
export interface TmdbCombinedCreditItem {
	id: number;
	media_type: 'movie' | 'tv';
	// movie titles
	title?: string;
	release_date?: string;
	// tv titles
	name?: string;
	first_air_date?: string;
	poster_path?: string | null;
	character?: string;
	job?: string;
}

/** Unpaginated — every title the person worked on. */
export interface TmdbCombinedCredits {
	cast?: TmdbCombinedCreditItem[];
	crew?: TmdbCombinedCreditItem[];
}

export interface TmdbPersonResponse {
	id: number;
	name?: string;
	biography?: string;
	birthday?: string | null;
	deathday?: string | null;
	place_of_birth?: string | null;
	known_for_department?: string;
	profile_path?: string | null;
	combined_credits?: TmdbCombinedCredits;
}

export interface PersonCredit {
	tmdbId: number;
	type: 'movie' | 'show';
	title: string;
	year: number | null;
	/** `YYYY-MM-DD`, or null when TMDB has no date (unannounced). */
	date: string | null;
	posterPath: string | null;
	/** What they did on it — a character name, or their jobs joined ("Director, Writer"). */
	role: string;
}

/** Normalized, app-facing person detail. */
export interface PersonDetail {
	tmdbId: number;
	name: string;
	biography: string;
	/** `YYYY-MM-DD`, or null. */
	birthday: string | null;
	/** `YYYY-MM-DD`, or null. */
	deathday: string | null;
	placeOfBirth: string | null;
	knownForDepartment: string | null;
	profilePath: string | null;
}

/** TMDB returns `combined_credits` whole: `upcoming` comes back in full on every page, only `credits` pages. */
export interface PersonCreditsPage {
	person: PersonDetail;
	/** Titles dated in the future, or with no date at all — soonest first, undated last. */
	upcoming: PersonCredit[];
	credits: PersonCredit[];
	/** 1-based, clamped to `totalPages`. */
	page: number;
	/** At least 1, even when there are no released credits. */
	totalPages: number;
	/** Total released credits across all pages. */
	total: number;
}

export interface CastMember {
	id: number;
	name: string;
	character: string;
	profilePath: string | null;
}

/** Carries the TMDB person id, not just the name, so a crew credit links to that person's page like a cast avatar. */
export interface CrewMember {
	id: number;
	name: string;
}

/** A normalized YouTube trailer (its `key` is the YouTube video id). */
export interface MediaTrailer {
	key: string;
	name: string;
}

export interface MediaDetail {
	tmdbId: number;
	type: 'movie' | 'show';
	title: string;
	year: number | null;
	overview: string;
	posterPath: string | null;
	backdropPath: string | null;
	/** TMDB vote average (0–10), or null. */
	rating: number | null;
	voteCount: number;
	/** In minutes (movie runtime, or a show's per-episode run time), or null. */
	runtime: number | null;
	genres: string[];
	cast: CastMember[];
	director: CrewMember | null;
	writers: CrewMember[];
	producers: CrewMember[];
	creators: CrewMember[];
	trailer: MediaTrailer | null;
	/** `YYYY-MM-DD`. Movies only. */
	releaseDate: string | null;
	/** Shows only. */
	status: string | null;
	/** Shows only. */
	inProduction: boolean | null;
	/** `YYYY-MM-DD`. Shows only. */
	firstAirDate: string | null;
	/** `YYYY-MM-DD`. Shows only. */
	lastAirDate: string | null;
	seasons: Season[];
	/** TMDB `recommendations` + `similar` merged: deduped by id, poster-only, capped, same `type` as this title. */
	similar: MediaSearchResult[];
}

export interface Season {
	seasonNumber: number;
	name: string;
	episodeCount: number;
	/** `YYYY-MM-DD`, or null. */
	airDate: string | null;
	posterPath: string | null;
	overview: string;
}

export interface Episode {
	episodeNumber: number;
	name: string;
	/** `YYYY-MM-DD`, or null. */
	airDate: string | null;
	overview: string;
	stillPath: string | null;
	/** In minutes, or null. */
	runtime: number | null;
}

export interface SeasonDetail {
	seasonNumber: number;
	name: string;
	/** Richer than the show-detail season summary's overview. */
	overview: string;
	episodes: Episode[];
}
