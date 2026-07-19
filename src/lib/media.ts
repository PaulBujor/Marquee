const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';

/**
 * Build a TMDB poster URL, or null when the item has no poster. Client-safe (pure, no secrets),
 * so it's the single source of truth shared by the server load and the UI.
 */
export function posterUrl(path: string | null, size = 'w342'): string | null {
	if (!path) return null;
	return `${TMDB_IMAGE_BASE_URL}/${size}${path}`;
}
