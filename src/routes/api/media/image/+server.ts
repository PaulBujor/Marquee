import { error } from '@sveltejs/kit';
import { tmdbImageUrl, TMDB_IMAGE_SIZES, type TmdbImageSize } from '$lib/media';
import type { RequestHandler } from './$types';

/**
 * Same-origin proxy for TMDB images, so the client can fetch poster/backdrop **bytes** to cache
 * as offline blobs (MRQ-111b) — `image.tmdb.org` sends no CORS headers, so a direct client fetch
 * is blocked. Locked down to the TMDB image CDN with an allow-listed size + path so it can't be
 * used as an open proxy. Auth-gated; long-cached (image paths are immutable).
 */
const SIZES = new Set<string>(TMDB_IMAGE_SIZES);
const PATH_RE = /^\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/i;

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const size = url.searchParams.get('size') ?? '';
	const path = url.searchParams.get('path') ?? '';
	if (!SIZES.has(size) || !PATH_RE.test(path)) error(400, 'Bad image request');

	const upstream = await fetch(tmdbImageUrl(path, size as TmdbImageSize));
	if (!upstream.ok) error(502, 'Upstream image error');

	return new Response(upstream.body, {
		headers: {
			'content-type': upstream.headers.get('content-type') ?? 'image/jpeg',
			'cache-control': 'public, max-age=31536000, immutable'
		}
	});
};
