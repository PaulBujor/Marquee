import { error, json } from '@sveltejs/kit';
import { createTmdbClient, TmdbError, type SearchResult } from '$lib/server/tmdb';
import { searchLinkedMedia } from '$lib/server/media/search';
import type { RequestHandler } from './$types';

/**
 * Live TMDB search driven by `?q=` (no cache), auth-gated. Returns titles and people in one
 * relevance-ordered list, each row tagged with its `kind`. When TMDB is unreachable, degrade to a
 * substring search over the shared `linked` catalog we already hold (`degraded: true`) so the screen
 * still returns something — that catalog is titles only, so a degraded search finds no people.
 * Called by the search page's universal load; **offline** the client falls back to its own IndexedDB
 * catalog instead (this endpoint is never reached).
 */
export const GET: RequestHandler = async ({ locals, platform, url }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const q = url.searchParams.get('q')?.trim() ?? '';
	if (!q) return json({ results: [], degraded: false });

	if (!platform) error(503, 'Service unavailable.');
	const apiKey = platform.env.TMDB_API_KEY;
	if (!apiKey) error(503, 'Search is not configured.');

	try {
		const results = await createTmdbClient(apiKey).search(q);
		return json({ results, degraded: false });
	} catch (err) {
		if (err instanceof TmdbError) {
			console.error('TMDB search failed:', err.status, err.message);
			// Fall back to the shared library so the query still returns what we already know. We only
			// hold titles, so these are all `media` — the People tab is legitimately empty here.
			const media = locals.db ? await searchLinkedMedia(locals.db, q) : [];
			const results: SearchResult[] = media.map((m) => ({ kind: 'media', ...m }));
			return json({ results, degraded: true });
		}
		throw err;
	}
};
