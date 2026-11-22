import { env } from '#lib/server/bindings.js';
import { error, json } from '@sveltejs/kit';
import { createTmdbClient, TmdbError, type SearchResult } from '#lib/server/tmdb/index.js';
import { searchLinkedMedia } from '#lib/server/media/search.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) error(401, 'Unauthorized');

	const q = url.searchParams.get('q')?.trim() ?? '';
	if (!q) return json({ results: [], degraded: false });

	if (!env) error(503, 'Service unavailable.');
	const apiKey = env.TMDB_API_KEY;
	if (!apiKey) error(503, 'Search is not configured.');

	try {
		const results = await createTmdbClient(apiKey).search(q);
		return json({ results, degraded: false });
	} catch (err) {
		if (err instanceof TmdbError) {
			console.error('TMDB search failed:', err.status, err.message);
			// We only hold titles, so these are all `media` — the People tab is legitimately empty here.
			const media = locals.db ? await searchLinkedMedia(locals.db, q) : [];
			const results: SearchResult[] = media.map((m) => ({ kind: 'media', ...m }));
			return json({ results, degraded: true });
		}
		throw err;
	}
};
