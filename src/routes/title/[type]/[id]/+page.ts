import { error, redirect } from '@sveltejs/kit';
import { browser } from '$app/environment';
import { buildOfflineDetail, type OfflineTitle } from '$lib/client/media/offline-detail';
import type { MediaDetail, SeasonDetail } from '$lib/server/tmdb';
import type { PageLoad } from './$types';

/**
 * Offline-first title load. Return the cached IndexedDB copy (`base`) immediately so the page renders
 * from local data with no wait, and stream the full network detail (`enriched`) — cast, trailer,
 * similar, rating — to fill in when it arrives. When truly offline the enrichment resolves to
 * `offline` and the page shows placeholders for those sections; a reconnect re-runs this load (it
 * `depends('app:title')`) to enrich in place. Auth is checked from the cached layout data, so
 * navigation stays offline-safe.
 */
export type EnrichResult =
	| { status: 'ok'; detail: MediaDetail; season: SeasonDetail | null }
	| { status: 'notfound' }
	| { status: 'offline' }
	| { status: 'error' };

export const load: PageLoad = async ({ params, url, fetch, parent, depends }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/login');

	const type = params.type === 'movie' || params.type === 'show' ? params.type : null;
	const id = Number(params.id);
	if (!type || !Number.isInteger(id) || id <= 0) error(404, 'Not found.');

	const season = url.searchParams.get('season');
	depends('app:title'); // a reconnect invalidates this to re-enrich in place

	// The local copy renders instantly; the network copy streams in to enrich it.
	const base: OfflineTitle | null = browser ? await buildOfflineDetail(type, id, season) : null;
	return { type, id, season, base, enriched: fetchEnriched(fetch, type, id, season) };
};

async function fetchEnriched(
	fetch: typeof globalThis.fetch,
	type: 'movie' | 'show',
	id: number,
	season: string | null
): Promise<EnrichResult> {
	const qs = season && season.trim() !== '' ? `?season=${encodeURIComponent(season)}` : '';
	try {
		const res = await fetch(`/api/title/${type}/${id}${qs}`);
		if (res.ok) {
			const data = (await res.json()) as { detail: MediaDetail; season: SeasonDetail | null };
			return { status: 'ok', detail: data.detail, season: data.season };
		}
		if (res.status === 404) return { status: 'notfound' };
		return { status: 'error' };
	} catch {
		// Network failure — offline. The page keeps showing the cached copy with offline placeholders.
		return { status: 'offline' };
	}
}
