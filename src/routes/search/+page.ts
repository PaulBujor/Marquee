import { redirect } from '@sveltejs/kit';
import type { MediaSearchResult } from '$lib/server/tmdb';
import type { PageLoad } from './$types';

/**
 * Universal (not server) load so search works **offline**: online it fetches live TMDB results from
 * `/api/search`; offline that fetch fails and we return empty, letting the page's client-side
 * `searchLocalMedia` take over (see `+page.svelte`). A server load here would make an offline
 * client-side navigation fail outright (SvelteKit can't fetch its `__data.json`). The query lives in
 * `?q=` so it's shareable and restored on back-navigation.
 */
export const load: PageLoad = async ({ url, fetch, parent }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/login');

	const q = url.searchParams.get('q')?.trim() ?? '';
	if (!q) return { q: '', results: [] as MediaSearchResult[], degraded: false };

	try {
		const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
		if (res.ok) {
			const data = (await res.json()) as { results: MediaSearchResult[]; degraded: boolean };
			return { q, results: data.results, degraded: data.degraded };
		}
		// A non-OK response (e.g. 503 with no TMDB key) — show the query with no results, not an error.
		return { q, results: [] as MediaSearchResult[], degraded: false };
	} catch {
		// Network failure — offline. The client's local-catalog search fills in.
		return { q, results: [] as MediaSearchResult[], degraded: false };
	}
};
