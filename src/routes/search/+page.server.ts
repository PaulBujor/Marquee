import { error, redirect } from '@sveltejs/kit';
import { createTmdbClient, TmdbError } from '$lib/server/tmdb';
import type { PageServerLoad } from './$types';

/**
 * Live TMDB search driven by the `?q=` URL param (no cache — MRQ-36). The query lives in the
 * URL so it's shareable and restored on back-navigation from a result. Auth-gated.
 */
export const load: PageServerLoad = async ({ locals, platform, url }) => {
	if (!locals.user) redirect(303, '/login');

	const q = url.searchParams.get('q')?.trim() ?? '';
	if (!q) return { q: '', results: [], failed: false };

	if (!platform) error(503, 'Service unavailable.');
	const apiKey = platform.env.TMDB_API_KEY;
	if (!apiKey) error(503, 'Search is not configured.');

	try {
		const results = await createTmdbClient(apiKey).search(q);
		return { q, results, failed: false };
	} catch (err) {
		if (err instanceof TmdbError) {
			// Surface a soft error in the UI (keep the input usable) rather than a 502 page.
			console.error('TMDB search failed:', err.status, err.message);
			return { q, results: [], failed: true };
		}
		throw err;
	}
};
