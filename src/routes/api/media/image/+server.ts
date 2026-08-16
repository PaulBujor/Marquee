import { error } from '@sveltejs/kit';
import { tmdbImageUrl, TMDB_IMAGE_SIZES, type TmdbImageSize } from '$lib/media';
import { fetchWithTimeout } from '$lib/resilience';
import type { RequestHandler } from './$types';

/** Wall-clock budget for the upstream image fetch, so a stalled CDN can't hold the Worker open. */
const IMAGE_TIMEOUT_MS = 10_000;

/**
 * Same-origin proxy for TMDB images, so the client can fetch poster/backdrop **bytes** to cache
 * as offline blobs — `image.tmdb.org` sends no CORS headers, so a direct client fetch
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

	let upstream: Response;
	try {
		upstream = await fetchWithTimeout(tmdbImageUrl(path, size as TmdbImageSize), {
			timeoutMs: IMAGE_TIMEOUT_MS
		});
	} catch (err) {
		console.error(`media/image: upstream fetch failed for ${size}${path}`, err);
		error(502, 'Upstream image error');
	}
	if (!upstream.ok) {
		console.error(`media/image: upstream ${upstream.status} for ${size}${path}`);
		error(502, 'Upstream image error');
	}

	// Defensive: only ever relay an actual image back, never some other content type.
	const contentType = upstream.headers.get('content-type') ?? '';
	if (!contentType.startsWith('image/')) {
		console.error(`media/image: non-image content-type "${contentType}" for ${size}${path}`);
		error(502, 'Upstream is not an image');
	}

	return new Response(upstream.body, {
		headers: {
			'content-type': contentType,
			'cache-control': 'public, max-age=31536000, immutable'
		}
	});
};
