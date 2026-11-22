import { redirect } from '@sveltejs/kit';
import type { SearchResult } from '#lib/server/tmdb/index.js';
import type { PageLoad } from './$types';

/** Universal: a server load can't be fetched offline (SvelteKit can't load its `__data.json`), which would fail the navigation outright. */
export const load: PageLoad = async ({ url, fetch, parent }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/login');

	const q = url.searchParams.get('q')?.trim() ?? '';
	if (!q) return { q: '', results: [] as SearchResult[], degraded: false };

	try {
		const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
		if (res.ok) {
			const data = (await res.json()) as { results: SearchResult[]; degraded: boolean };
			return { q, results: data.results, degraded: data.degraded };
		}
		return { q, results: [] as SearchResult[], degraded: false };
	} catch {
		return { q, results: [] as SearchResult[], degraded: false };
	}
};
