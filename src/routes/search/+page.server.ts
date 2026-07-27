import { error, redirect } from '@sveltejs/kit';
import { createTmdbClient, TmdbError } from '$lib/server/tmdb';
import { searchLinkedMedia } from '$lib/server/media/search';
import type { PageServerLoad } from './$types';

/**
 * Live TMDB search driven by the `?q=` URL param (no cache — MRQ-36). The query lives in the
 * URL so it's shareable and restored on back-navigation from a result. Auth-gated.
 *
 * When TMDB is unreachable, degrade to a substring search over the shared `linked` catalog we
 * already hold (`degraded: true`) so the screen still returns results rather than going blank.
 */
export const load: PageServerLoad = async ({ locals, platform, url }) => {
	if (!locals.user) redirect(303, '/login');

	const q = url.searchParams.get('q')?.trim() ?? '';
	if (!q) return { q: '', results: [], degraded: false };

	if (!platform) error(503, 'Service unavailable.');
	const apiKey = platform.env.TMDB_API_KEY;
	if (!apiKey) error(503, 'Search is not configured.');

	try {
		const results = await createTmdbClient(apiKey).search(q);
		return { q, results, degraded: false };
	} catch (err) {
		if (err instanceof TmdbError) {
			console.error('TMDB search failed:', err.status, err.message);
			// Fall back to the shared library so the query still returns what we already know.
			const results = locals.db ? await searchLinkedMedia(locals.db, q) : [];
			return { q, results, degraded: true };
		}
		throw err;
	}
};
