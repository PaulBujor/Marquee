/**
 * TMDB image config + URL builders — the single client-safe source of truth (pure, no secrets)
 * shared by the server load, the image proxy route, and the UI. TMDB-specific for now; when
 * another provider lands its base/sizes slot in here, and callers keep using these helpers.
 */
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';

/** The TMDB image sizes we request — a subset of TMDB's `w*` steps plus `original`. */
export const TMDB_IMAGE_SIZES = ['w185', 'w342', 'w500', 'w780', 'original'] as const;
export type TmdbImageSize = (typeof TMDB_IMAGE_SIZES)[number];

/** Default size per artwork kind, named so call sites don't sprinkle bare `w342`/`w780`. */
export const POSTER_SIZE: TmdbImageSize = 'w342';
export const BACKDROP_SIZE: TmdbImageSize = 'w780';

/** The absolute TMDB image URL for a path + size (e.g. `/poster.jpg` → `…/t/p/w342/poster.jpg`). */
export function tmdbImageUrl(path: string, size: TmdbImageSize): string {
	return `${TMDB_IMAGE_BASE_URL}/${size}${path}`;
}

/** A sized TMDB image URL, or null when the item has no image path. */
export function posterUrl(path: string | null, size: TmdbImageSize = POSTER_SIZE): string | null {
	if (!path) return null;
	return tmdbImageUrl(path, size);
}

/**
 * Same-origin proxy URL for a TMDB image, used to **fetch the bytes** to cache offline
 * (MRQ-111b). `image.tmdb.org` doesn't send CORS headers, so a direct client `fetch` is
 * blocked; the `<img>` tag can still use {@link posterUrl} directly. Null when there's no path.
 */
export function proxiedImageUrl(
	path: string | null,
	size: TmdbImageSize = POSTER_SIZE
): string | null {
	if (!path) return null;
	return `/api/media/image?size=${encodeURIComponent(size)}&path=${encodeURIComponent(path)}`;
}
