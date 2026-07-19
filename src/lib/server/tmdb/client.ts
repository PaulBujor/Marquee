import type { MediaSearchResult, TmdbMultiSearchItem, TmdbMultiSearchResponse } from './types';

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';

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

/** Build a TMDB poster URL. Returns null when the item has no poster. */
export function posterUrl(path: string | null, size = 'w342'): string | null {
	if (!path) return null;
	return `${TMDB_IMAGE_BASE_URL}/${size}${path}`;
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
 * TMDB API client. `createTmdbClient(apiKey)` is the single place the API key and base URL
 * live; the key is read off `platform.env.TMDB_API_KEY` at the call site (see the search endpoint).
 */
export function createTmdbClient(apiKey: string) {
	async function request(path: string, params: Record<string, string>): Promise<unknown> {
		const url = new URL(`${TMDB_BASE_URL}${path}`);
		url.searchParams.set('api_key', apiKey);
		for (const [key, value] of Object.entries(params)) {
			url.searchParams.set(key, value);
		}

		let res: Response;
		try {
			res = await fetch(url, { headers: { accept: 'application/json' } });
		} catch (err) {
			throw new TmdbError(`TMDB request failed: ${String(err)}`, 502);
		}
		if (!res.ok) {
			throw new TmdbError(`TMDB responded ${res.status}`, res.status);
		}
		return res.json();
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
		}
	};
}

export type TmdbClient = ReturnType<typeof createTmdbClient>;
