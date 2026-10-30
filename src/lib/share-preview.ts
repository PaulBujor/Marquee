// Catalogue data only, never a user's tracking state — public pages render it with no server-only import.

export interface CastCredit {
	name: string;
	profilePath: string | null;
}

export interface CrewCredits {
	director: string | null;
	creators: string[];
	writers: string[];
	producers: string[];
}

export interface ShareTrailer {
	key: string;
	name: string;
}
export interface SharePreview {
	type: 'movie' | 'show';
	externalId: number;
	name: string;
	year: number | null;
	summary: string | null;
	imagePath: string | null;
	backdropPath: string | null;
	/** TMDB vote average (0–10). */
	rating: number | null;
	/** Minutes — a movie's runtime, or a show's per-episode runtime. */
	runtime: number | null;
	/** `YYYY-MM-DD`: a movie's release date, or a show's first air date. */
	releasedOn: string | null;
	/** Shows only: seasons excluding Specials, for the header badge. */
	seasons: number;
	production: 'in_production' | 'ended' | null;
	genres: string[];
	crew: CrewCredits;
	cast: CastCredit[];
	trailer: ShareTrailer | null;
	updatedAt: number;
}

export type PublicShareState =
	{ state: 'ready'; preview: SharePreview } | { state: 'cold' } | { state: 'disabled' };

/** The TMDB attribution their terms require wherever their data is shown. */
export const TMDB_ATTRIBUTION =
	'This product uses the TMDB API but is not endorsed or certified by TMDB.';
