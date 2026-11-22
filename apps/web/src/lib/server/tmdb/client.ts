import type { ZodType } from 'zod';
import { CircuitBreaker, fetchWithTimeout, withRetry } from '#lib/resilience.js';
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
	SearchResult,
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

/** Module-level so it persists across requests in a Worker isolate — a sustained outage fails fast. */
const tmdbBreaker = new CircuitBreaker({ maxFailures: 5, cooldownMs: 30_000, name: 'tmdb' });
const TMDB_RETRY = { maxAttempts: 3, baseMs: 300, maxMs: 3000 };
/** Per-attempt: with `maxAttempts: 3` an untimed stall could hold a Worker invocation open three times over. */
const TMDB_TIMEOUT_MS = 5_000;

const CAST_LIMIT = 10;
const SIMILAR_LIMIT = 20;
const CREW_LIMIT = 3;
const DIRECTOR_JOBS = new Set(['Director']);
const WRITER_JOBS = new Set(['Writer', 'Screenplay', 'Story', 'Teleplay']);
const PRODUCER_JOBS = new Set(['Producer', 'Executive Producer']);

/** Deduped by name — TMDB lists the same person once per job they held. */
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

const PERSON_CREDITS_PAGE_SIZE = 20;

export class TmdbError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = 'TmdbError';
	}
}

/** Throws a 502 `TmdbError` so `shouldRetry` treats a shape change like any other bad upstream response. */
function parseTmdb<T>(schema: ZodType<T>, data: unknown, what: string): T {
	const result = schema.safeParse(data);
	if (!result.success) {
		console.error(`TMDB ${what}: unexpected response shape`, result.error.issues.slice(0, 3));
		throw new TmdbError(`TMDB ${what} returned an unexpected shape`, 502);
	}
	return result.data;
}

function parseYear(date: string | undefined): number | null {
	if (!date) return null;
	const year = Number(date.slice(0, 4));
	return Number.isFinite(year) && year > 0 ? year : null;
}

function normalize(item: TmdbMultiSearchItem): SearchResult | null {
	if (item.media_type === 'movie') {
		return {
			kind: 'media',
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
			kind: 'media',
			tmdbId: item.id,
			type: 'show',
			title: item.name ?? '',
			year: parseYear(item.first_air_date),
			posterPath: item.poster_path ?? null,
			overview: item.overview ?? ''
		};
	}
	if (item.media_type === 'person') {
		// Every department, not the three the ticket names — dropping a writer would look like the app doesn't know them.
		return {
			kind: 'person',
			tmdbId: item.id,
			name: item.name ?? '',
			profilePath: item.profile_path ?? null,
			department: item.known_for_department ?? null,
			knownFor: (item.known_for ?? [])
				.map((credit) => credit.title ?? credit.name ?? '')
				.filter((title) => title !== '')
		};
	}
	return null;
}

/** These endpoints send no `media_type` — it's implied by the movie-vs-tv endpoint, so the caller passes `type`. */
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

/** Recommendations first (TMDB's curated picks), then similar to backfill; poster-only, since a posterless tile is useless. */
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

	// Shows keep per-episode crew off this response, so their nearest equivalent is `created_by`.
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

/** A person is often credited several times on one title, so rows are deduped by `(media_type, id)` with roles merged. */
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
			// won't fix by retrying.
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
		async search(query: string): Promise<SearchResult[]> {
			const trimmed = query.trim();
			if (!trimmed) return [];

			const raw = await request('/search/multi', { query: trimmed, include_adult: 'false' });
			const data = parseTmdb(
				multiSearchResponseSchema,
				raw,
				'search'
			) as unknown as TmdbMultiSearchResponse;

			return (data.results ?? []).map(normalize).filter((r): r is SearchResult => r !== null);
		},

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

		/** TMDB has no paged filmography endpoint — `combined_credits` comes back whole, so the paging is ours. */
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
