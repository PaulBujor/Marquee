const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';

/** A subset of TMDB's `w*` steps plus `original` — the only sizes the CDN serves. */
export const TMDB_IMAGE_SIZES = ['w185', 'w342', 'w500', 'w780', 'original'] as const;
export type TmdbImageSize = (typeof TMDB_IMAGE_SIZES)[number];

export const POSTER_SIZE: TmdbImageSize = 'w342';
export const BACKDROP_SIZE: TmdbImageSize = 'w780';

export function tmdbImageUrl(path: string, size: TmdbImageSize): string {
	return `${TMDB_IMAGE_BASE_URL}/${size}${path}`;
}

export function posterUrl(path: string | null, size: TmdbImageSize = POSTER_SIZE): string | null {
	if (!path) return null;
	return tmdbImageUrl(path, size);
}

// `image.tmdb.org` sends no CORS headers, so fetching the bytes to cache offline must go same-origin; an `<img>` can still use {@link posterUrl} directly.
export function proxiedImageUrl(
	path: string | null,
	size: TmdbImageSize = POSTER_SIZE
): string | null {
	if (!path) return null;
	return `/api/media/image?size=${encodeURIComponent(size)}&path=${encodeURIComponent(path)}`;
}

/** TMDB sends `""`, not null, for a missing overview. */
export function hasDescription(overview: string | null | undefined): boolean {
	return (overview ?? '').trim().length > 0;
}
