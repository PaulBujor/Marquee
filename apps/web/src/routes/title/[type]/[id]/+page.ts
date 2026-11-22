import { error, redirect } from '@sveltejs/kit';
import { browser } from '$app/env';
import { buildOfflineDetail, type OfflineTitle } from '#lib/client/media/offline-detail.js';
import type { MediaDetail, SeasonDetail } from '#lib/server/tmdb/index.js';
import type { PageLoad } from './$types';

/** Returns the cached IndexedDB copy (`base`) beside the streamed enrichment; `depends('app:title')` lets a reconnect re-run it in place. */
export type EnrichResult =
	| {
			status: 'ok';
			detail: MediaDetail;
			season: SeasonDetail | null;
	  }
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
		return { status: 'offline' };
	}
}
