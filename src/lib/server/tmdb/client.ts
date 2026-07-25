import { CircuitBreaker, withRetry } from '$lib/resilience';
import type {
	MediaDetail,
	MediaSearchResult,
	SeasonDetail,
	TmdbMovieDetailsResponse,
	TmdbMultiSearchItem,
	TmdbMultiSearchResponse,
	TmdbSeasonDetailResponse,
	TmdbSimilarItem,
	TmdbTvDetailsResponse
} from './types';

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

/**
 * Module-level circuit breaker (persists across requests in a Worker isolate) so a sustained
 * TMDB outage fails fast instead of every request retrying into a wall. Retries use short
 * server-side backoff — a metadata fetch shouldn't hold a request open for long.
 */
const tmdbBreaker = new CircuitBreaker({ maxFailures: 5, cooldownMs: 30_000, name: 'tmdb' });
const TMDB_RETRY = { maxAttempts: 3, baseMs: 300, maxMs: 3000 };

/** How many cast members the detail page shows (TMDB orders `cast` by billing). */
const CAST_LIMIT = 10;

/** How many "similar" titles the detail page's row shows (recommendations + similar, merged). */
const SIMILAR_LIMIT = 20;

/** Thrown when TMDB responds with a non-2xx status, so callers can map it to a clean HTTP error. */
export class TmdbError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = 'TmdbError';
	}
}

/** Parse a leading 4-digit year out of a TMDB date string (`YYYY-MM-DD`). */
function parseYear(date: string | undefined): number | null {
	if (!date) return null;
	const year = Number(date.slice(0, 4));
	return Number.isFinite(year) && year > 0 ? year : null;
}

/** Normalize a raw multi-search row to the app shape, or null if it isn't a movie/show. */
function normalize(item: TmdbMultiSearchItem): MediaSearchResult | null {
	if (item.media_type === 'movie') {
		return {
			tmdbId: item.id,
			type: 'movie',
			title: item.title ?? '',
			year: parseYear(item.release_date),
			posterPath: item.poster_path ?? null,
			overview: item.overview ?? ''
		};
	}
	if (item.media_type === 'tv') {
		return {
			tmdbId: item.id,
			type: 'show',
			title: item.name ?? '',
			year: parseYear(item.first_air_date),
			posterPath: item.poster_path ?? null,
			overview: item.overview ?? ''
		};
	}
	// `person` (and any future media_type) are dropped.
	return null;
}

/**
 * Normalize a `recommendations` / `similar` row. These endpoints don't send `media_type` (it's
 * implied by the movie-vs-tv endpoint), so the caller passes `type`.
 */
function normalizeSimilar(type: 'movie' | 'show', item: TmdbSimilarItem): MediaSearchResult {
	const isMovie = type === 'movie';
	return {
		tmdbId: item.id,
		type,
		title: (isMovie ? item.title : item.name) ?? '',
		year: parseYear(isMovie ? item.release_date : item.first_air_date),
		posterPath: item.poster_path ?? null,
		overview: item.overview ?? ''
	};
}

/**
 * Merge the appended `recommendations` + `similar` lists into one "more like this" row:
 * recommendations first (TMDB's curated picks), then similar (keyword/genre overlap) to backfill,
 * deduped by id, poster-only (a posterless tile is useless in the row), and capped.
 */
function mergeSimilar(
	type: 'movie' | 'show',
	selfId: number,
	recommendations: TmdbSimilarItem[],
	similar: TmdbSimilarItem[]
): MediaSearchResult[] {
	const seen = new Set<number>([selfId]);
	const out: MediaSearchResult[] = [];
	for (const item of [...recommendations, ...similar]) {
		if (seen.has(item.id) || !item.poster_path) continue;
		seen.add(item.id);
		out.push(normalizeSimilar(type, item));
		if (out.length >= SIMILAR_LIMIT) break;
	}
	return out;
}

/** Normalize a raw movie/tv detail response to the app-facing `MediaDetail` shape. */
function normalizeDetails(
	type: 'movie' | 'show',
	data: TmdbMovieDetailsResponse | TmdbTvDetailsResponse
): MediaDetail {
	const isMovie = type === 'movie';
	const movie = data as TmdbMovieDetailsResponse;
	const tv = data as TmdbTvDetailsResponse;

	const trailer = (data.videos?.results ?? []).find(
		(v) => v.site === 'YouTube' && v.type === 'Trailer'
	);

	return {
		tmdbId: data.id,
		type,
		title: (isMovie ? movie.title : tv.name) ?? '',
		year: parseYear(isMovie ? movie.release_date : tv.first_air_date),
		overview: data.overview ?? '',
		posterPath: data.poster_path ?? null,
		backdropPath: data.backdrop_path ?? null,
		// TMDB reports 0 for unrated titles — surface that as null rather than a fake "0/10".
		rating:
			typeof data.vote_average === 'number' && data.vote_average > 0 ? data.vote_average : null,
		voteCount: data.vote_count ?? 0,
		runtime: (isMovie ? movie.runtime : tv.episode_run_time?.[0]) ?? null,
		genres: (data.genres ?? []).map((g) => g.name),
		cast: (data.credits?.cast ?? []).slice(0, CAST_LIMIT).map((c) => ({
			id: c.id,
			name: c.name,
			character: c.character ?? '',
			profilePath: c.profile_path ?? null
		})),
		trailer: trailer ? { key: trailer.key, name: trailer.name } : null,
		releaseDate: isMovie ? (movie.release_date ?? null) : null,
		status: isMovie ? null : (tv.status ?? null),
		inProduction: isMovie ? null : (tv.in_production ?? null),
		firstAirDate: isMovie ? null : (tv.first_air_date ?? null),
		lastAirDate: isMovie ? null : (tv.last_air_date ?? null),
		seasons: isMovie
			? []
			: (tv.seasons ?? []).map((s) => ({
					seasonNumber: s.season_number,
					name: s.name ?? '',
					episodeCount: s.episode_count ?? 0,
					airDate: s.air_date ?? null,
					posterPath: s.poster_path ?? null,
					overview: s.overview ?? ''
				})),
		similar: mergeSimilar(
			type,
			data.id,
			data.recommendations?.results ?? [],
			data.similar?.results ?? []
		)
	};
}

/** Normalize a raw `/tv/{id}/season/{n}` response to the app-facing `SeasonDetail` shape. */
function normalizeSeason(data: TmdbSeasonDetailResponse): SeasonDetail {
	return {
		seasonNumber: data.season_number,
		name: data.name ?? '',
		episodes: (data.episodes ?? []).map((e) => ({
			episodeNumber: e.episode_number,
			name: e.name ?? '',
			airDate: e.air_date ?? null,
			overview: e.overview ?? '',
			stillPath: e.still_path ?? null,
			runtime: e.runtime ?? null
		}))
	};
}

/**
 * TMDB API client. `createTmdbClient(apiKey)` is the single place the API key and base URL
 * live; the key is read off `platform.env.TMDB_API_KEY` at the call site (see the search endpoint).
 */
export function createTmdbClient(apiKey: string) {
	async function request(path: string, params: Record<string, string>): Promise<unknown> {
		if (!tmdbBreaker.canAttempt()) {
			throw new TmdbError('TMDB temporarily unavailable (circuit open)', 503);
		}
		const url = new URL(`${TMDB_BASE_URL}${path}`);
		url.searchParams.set('api_key', apiKey);
		for (const [key, value] of Object.entries(params)) {
			url.searchParams.set(key, value);
		}

		try {
			// Retry only transient failures (network error → 502, or 5xx/429); a 4xx (bad id/key)
			// won't fix by retrying, so fail fast.
			const data = await withRetry(
				async () => {
					let res: Response;
					try {
						res = await fetch(url, { headers: { accept: 'application/json' } });
					} catch (err) {
						throw new TmdbError(`TMDB request failed: ${String(err)}`, 502);
					}
					if (!res.ok) throw new TmdbError(`TMDB responded ${res.status}`, res.status);
					return res.json();
				},
				{
					...TMDB_RETRY,
					shouldRetry: (err) =>
						err instanceof TmdbError && (err.status >= 500 || err.status === 429)
				}
			);
			tmdbBreaker.recordSuccess();
			return data;
		} catch (err) {
			tmdbBreaker.recordFailure();
			throw err;
		}
	}

	return {
		/** Live multi-search for movies & shows. Returns normalized results (people filtered out). */
		async search(query: string): Promise<MediaSearchResult[]> {
			const trimmed = query.trim();
			if (!trimmed) return [];

			const data = (await request('/search/multi', {
				query: trimmed,
				include_adult: 'false'
			})) as TmdbMultiSearchResponse;

			return (data.results ?? []).map(normalize).filter((r): r is MediaSearchResult => r !== null);
		},

		/** Fetch a single movie/show with credits, images, videos, and similar titles appended. */
		async getDetails(type: 'movie' | 'show', id: number): Promise<MediaDetail> {
			const path = type === 'movie' ? `/movie/${id}` : `/tv/${id}`;
			const data = (await request(path, {
				append_to_response: 'credits,images,videos,recommendations,similar'
			})) as TmdbMovieDetailsResponse | TmdbTvDetailsResponse;

			return normalizeDetails(type, data);
		},

		/** Fetch a single TV season with its episodes, normalized. */
		async getSeason(showId: number, seasonNumber: number): Promise<SeasonDetail> {
			const data = (await request(
				`/tv/${showId}/season/${seasonNumber}`,
				{}
			)) as TmdbSeasonDetailResponse;

			return normalizeSeason(data);
		}
	};
}

export type TmdbClient = ReturnType<typeof createTmdbClient>;
