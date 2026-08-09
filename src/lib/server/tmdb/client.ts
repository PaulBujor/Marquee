import type { ZodType } from 'zod';
import { CircuitBreaker, fetchWithTimeout, withRetry } from '$lib/resilience';
import {
	movieDetailsResponseSchema,
	multiSearchResponseSchema,
	personResponseSchema,
	seasonDetailResponseSchema,
	tvDetailsResponseSchema
} from './schemas';
import type {
	CrewMember,
	MediaDetail,
	MediaSearchResult,
	PersonCredit,
	PersonCreditsPage,
	PersonDetail,
	SeasonDetail,
	TmdbCombinedCreditItem,
	TmdbCombinedCredits,
	TmdbCrewMember,
	TmdbMovieDetailsResponse,
	TmdbMultiSearchItem,
	TmdbMultiSearchResponse,
	TmdbPersonResponse,
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
/**
 * Per-attempt wall-clock budget. A metadata fetch shouldn't hold a Worker invocation open on a
 * stalled connection — and with `maxAttempts: 3` an untimed stall could stack three times over.
 */
const TMDB_TIMEOUT_MS = 5_000;

/** How many cast members the detail page shows (TMDB orders `cast` by billing). */
const CAST_LIMIT = 10;

/** How many "similar" titles the detail page's row shows (recommendations + similar, merged). */
const SIMILAR_LIMIT = 20;

/** How many names to keep per crew role (writers / producers / creators) — the detail page lists a few. */
const CREW_LIMIT = 3;
const DIRECTOR_JOBS = new Set(['Director']);
const WRITER_JOBS = new Set(['Writer', 'Screenplay', 'Story', 'Teleplay']);
const PRODUCER_JOBS = new Set(['Producer', 'Executive Producer']);

/**
 * Unique crew whose `job` is in `jobs`, in TMDB order, capped at {@link CREW_LIMIT}. Deduped by
 * name — TMDB lists the same person once per job they held, and the detail page wants them once.
 */
function crewByJob(crew: TmdbCrewMember[], jobs: Set<string>): CrewMember[] {
	const members: CrewMember[] = [];
	for (const c of crew) {
		if (jobs.has(c.job ?? '') && !members.some((m) => m.name === c.name)) {
			members.push({ id: c.id, name: c.name });
		}
		if (members.length >= CREW_LIMIT) break;
	}
	return members;
}

/** How many released credits one page of a person's filmography carries. */
const PERSON_CREDITS_PAGE_SIZE = 20;

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

/**
 * Validate a TMDB payload against its shape, turning a mismatch into a `TmdbError` so it flows
 * through the same handling as any other bad upstream response — 502 is retried by `shouldRetry`,
 * and the search endpoint's degraded fallback still returns the local catalog.
 */
function parseTmdb<T>(schema: ZodType<T>, data: unknown, what: string): T {
	const result = schema.safeParse(data);
	if (!result.success) {
		console.error(`TMDB ${what}: unexpected response shape`, result.error.issues.slice(0, 3));
		throw new TmdbError(`TMDB ${what} returned an unexpected shape`, 502);
	}
	return result.data;
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

	// Crew: movies carry a real director/writer in `credits.crew`; shows keep per-episode crew off
	// this response, so their nearest equivalent is the top-level `created_by` (series creators).
	const crew = data.credits?.crew ?? [];

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
		director: isMovie ? (crewByJob(crew, DIRECTOR_JOBS)[0] ?? null) : null,
		writers: isMovie ? crewByJob(crew, WRITER_JOBS) : [],
		producers: crewByJob(crew, PRODUCER_JOBS),
		creators: isMovie
			? []
			: (tv.created_by ?? []).slice(0, CREW_LIMIT).map((c) => ({ id: c.id, name: c.name })),
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
		overview: data.overview ?? '',
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

/** Normalize the biographical half of a `/person/{id}` response. */
function normalizePerson(data: TmdbPersonResponse): PersonDetail {
	return {
		tmdbId: data.id,
		name: data.name ?? '',
		biography: data.biography ?? '',
		birthday: data.birthday ?? null,
		deathday: data.deathday ?? null,
		placeOfBirth: data.place_of_birth ?? null,
		knownForDepartment: data.known_for_department ?? null,
		profilePath: data.profile_path ?? null
	};
}

/** Normalize one `combined_credits` row; `role` is the character (cast) or the job (crew). */
function normalizeCredit(item: TmdbCombinedCreditItem): PersonCredit {
	const isMovie = item.media_type === 'movie';
	const date = (isMovie ? item.release_date : item.first_air_date) || null;
	return {
		tmdbId: item.id,
		type: isMovie ? 'movie' : 'show',
		title: (isMovie ? item.title : item.name) ?? '',
		year: parseYear(date ?? undefined),
		date,
		posterPath: item.poster_path ?? null,
		// Cast rows carry `character`, crew rows `job`; an empty character falls through to the job.
		role: item.character || item.job || ''
	};
}

/**
 * Flatten a person's `combined_credits` into the two lists the modal renders, split on `today`
 * (`YYYY-MM-DD`) into work that's out and work that isn't yet.
 *
 * A person is often credited several times on the same title — as an actor *and* a producer, or
 * under two crew jobs — so rows are deduped by `(media_type, id)` with their roles merged into one
 * label. Released work sorts newest-first (the filmography reading order); upcoming work sorts
 * soonest-first with undated (unannounced) titles last, since those are the least concrete.
 */
function normalizePersonCredits(
	credits: TmdbCombinedCredits,
	today: string
): { upcoming: PersonCredit[]; released: PersonCredit[] } {
	const byTitle = new Map<string, PersonCredit>();
	for (const item of [...(credits.cast ?? []), ...(credits.crew ?? [])]) {
		if (item.media_type !== 'movie' && item.media_type !== 'tv') continue;
		const credit = normalizeCredit(item);
		const key = `${item.media_type}:${item.id}`;
		const existing = byTitle.get(key);
		if (!existing) {
			byTitle.set(key, credit);
		} else if (credit.role && !existing.role.split(', ').includes(credit.role)) {
			existing.role = existing.role ? `${existing.role}, ${credit.role}` : credit.role;
		}
	}

	const upcoming: PersonCredit[] = [];
	const released: PersonCredit[] = [];
	for (const credit of byTitle.values()) {
		if (credit.date === null || credit.date > today) upcoming.push(credit);
		else released.push(credit);
	}

	// Undated rows sort to the end of `upcoming`; `released` is dated by construction.
	upcoming.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
	released.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
	return { upcoming, released };
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
						res = await fetchWithTimeout(url, {
							headers: { accept: 'application/json' },
							timeoutMs: TMDB_TIMEOUT_MS
						});
					} catch (err) {
						// Includes FetchTimeoutError — mapped to 502 so `shouldRetry` treats a stalled
						// connection as the transient failure it is.
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

			const raw = await request('/search/multi', { query: trimmed, include_adult: 'false' });
			const data = parseTmdb(
				multiSearchResponseSchema,
				raw,
				'search'
			) as unknown as TmdbMultiSearchResponse;

			return (data.results ?? []).map(normalize).filter((r): r is MediaSearchResult => r !== null);
		},

		/** Fetch a single movie/show with credits, images, videos, and similar titles appended. */
		async getDetails(type: 'movie' | 'show', id: number): Promise<MediaDetail> {
			const path = type === 'movie' ? `/movie/${id}` : `/tv/${id}`;
			const raw = await request(path, {
				append_to_response: 'credits,images,videos,recommendations,similar'
			});
			const schema = type === 'movie' ? movieDetailsResponseSchema : tvDetailsResponseSchema;
			const data = parseTmdb(schema, raw, `${type} details`) as unknown as
				TmdbMovieDetailsResponse | TmdbTvDetailsResponse;

			return normalizeDetails(type, data);
		},

		/**
		 * Fetch a person with everything they've worked on, as one page of credits.
		 *
		 * TMDB has no paged filmography endpoint — `combined_credits` comes back whole (hundreds of
		 * rows for a prolific actor), so the paging is ours: the caller asks for a page and only that
		 * slice crosses the wire to the client.
		 */
		async getPerson(id: number, page = 1): Promise<PersonCreditsPage> {
			const raw = await request(`/person/${id}`, { append_to_response: 'combined_credits' });
			const data = parseTmdb(personResponseSchema, raw, 'person') as unknown as TmdbPersonResponse;

			const today = new Date().toISOString().slice(0, 10);
			const { upcoming, released } = normalizePersonCredits(data.combined_credits ?? {}, today);

			const totalPages = Math.max(1, Math.ceil(released.length / PERSON_CREDITS_PAGE_SIZE));
			const current = Math.min(Math.max(1, Math.trunc(page)), totalPages);
			const start = (current - 1) * PERSON_CREDITS_PAGE_SIZE;

			return {
				person: normalizePerson(data),
				upcoming,
				credits: released.slice(start, start + PERSON_CREDITS_PAGE_SIZE),
				page: current,
				totalPages,
				total: released.length
			};
		},

		/** Fetch a single TV season with its episodes, normalized. */
		async getSeason(showId: number, seasonNumber: number): Promise<SeasonDetail> {
			const raw = await request(`/tv/${showId}/season/${seasonNumber}`, {});
			const data = parseTmdb(
				seasonDetailResponseSchema,
				raw,
				'season'
			) as unknown as TmdbSeasonDetailResponse;

			return normalizeSeason(data);
		}
	};
}

export type TmdbClient = ReturnType<typeof createTmdbClient>;
