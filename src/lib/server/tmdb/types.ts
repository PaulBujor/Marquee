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

/**
 * A single row from an appended `recommendations` / `similar` list. Same shape as a multi-search
 * row but **without `media_type`** — the type is implied by the endpoint (movie vs tv), so callers
 * pass it explicitly to {@link MediaSearchResult}.
 */
export interface TmdbSimilarItem {
	id: number;
	title?: string;
	release_date?: string;
	name?: string;
	first_air_date?: string;
	poster_path?: string | null;
	overview?: string;
}

/** The appended `recommendations` / `similar` object on a detail response. */
export interface TmdbSimilarResponse {
	results?: TmdbSimilarItem[];
}

// --- Detail (`/movie/{id}` & `/tv/{id}` with `append_to_response=credits,images,videos,recommendations,similar`) ---

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

/** A crew member from the appended `credits` — `job` (e.g. Director) + `department` (e.g. Directing). */
export interface TmdbCrewMember {
	id: number;
	name: string;
	job?: string;
	department?: string;
	profile_path?: string | null;
}

/** The appended `credits` object. */
export interface TmdbCredits {
	cast?: TmdbCastMember[];
	crew?: TmdbCrewMember[];
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
	recommendations?: TmdbSimilarResponse;
	similar?: TmdbSimilarResponse;
}

/** Raw `/tv/{id}` detail response (only consumed fields modelled). */
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
	/** Series creators — the show equivalent of a film's director/writer (per-episode crew isn't fetched). */
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

// --- Person (`/person/{id}` with `append_to_response=combined_credits`) ---

/**
 * A single row from a person's `combined_credits`. Movies and shows are mixed (hence `media_type`),
 * and the same row shape serves both lists: `cast` rows carry `character`, `crew` rows carry `job`.
 */
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

/** The appended `combined_credits` object — everything the person worked on, unpaginated. */
export interface TmdbCombinedCredits {
	cast?: TmdbCombinedCreditItem[];
	crew?: TmdbCombinedCreditItem[];
}

/** Raw `/person/{id}` response (only consumed fields modelled). */
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

/** One title a person worked on, as the person modal lists it. */
export interface PersonCredit {
	tmdbId: number;
	type: 'movie' | 'show';
	title: string;
	/** Release / first-air year, or null when TMDB has no date. */
	year: number | null;
	/** `YYYY-MM-DD`, or null when TMDB has no date (unannounced). */
	date: string | null;
	posterPath: string | null;
	/** What they did on it — a character name, or their jobs joined ("Director, Writer"). */
	role: string;
}

/** Normalized, app-facing person detail — the biographical half of the person modal. */
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

/**
 * A person plus one page of their credits. TMDB returns `combined_credits` whole, so the paging is
 * ours: `upcoming` (unreleased / undated work) is small and comes back in full on every page, while
 * the much longer released list is what actually pages.
 */
export interface PersonCreditsPage {
	person: PersonDetail;
	/** Titles dated in the future, or with no date at all — soonest first, undated last. */
	upcoming: PersonCredit[];
	/** Released credits, newest-first, sliced to `page`. */
	credits: PersonCredit[];
	/** 1-based, clamped to `totalPages`. */
	page: number;
	/** At least 1, even when there are no released credits. */
	totalPages: number;
	/** Total released credits across all pages. */
	total: number;
}

/** A normalized cast member for the detail UI. */
export interface CastMember {
	id: number;
	name: string;
	character: string;
	profilePath: string | null;
}

/**
 * A normalized crew member for the detail UI. Carries the TMDB person id (not just the name) so a
 * crew credit can open the person modal, same as a cast avatar.
 */
export interface CrewMember {
	id: number;
	name: string;
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
	/** The director (movies only), or null when unknown / for shows. */
	director: CrewMember | null;
	/** Writers (movies) — Writer / Screenplay / Story, deduped. Empty for shows. */
	writers: CrewMember[];
	/** Producers (Producer / Executive Producer), deduped. */
	producers: CrewMember[];
	/** Series creators (shows only), from TMDB `created_by`. Empty for movies. */
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
	/** Empty for movies. */
	seasons: Season[];
	/**
	 * "More like this" — TMDB `recommendations` + `similar` merged, deduped by id, poster-only,
	 * capped. Same media `type` as this title (the endpoints don't mix movies and shows).
	 */
	similar: MediaSearchResult[];
}

/** A normalized season summary for the detail page's season selector + hydration. */
export interface Season {
	seasonNumber: number;
	name: string;
	episodeCount: number;
	/** `YYYY-MM-DD`, or null. */
	airDate: string | null;
	posterPath: string | null;
	overview: string;
}

/** A normalized episode for the season episode list. */
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

/** A normalized single season with its episodes (`/tv/{id}/season/{n}`). */
export interface SeasonDetail {
	seasonNumber: number;
	name: string;
	episodes: Episode[];
}
