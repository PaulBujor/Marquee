import { error, redirect } from '@sveltejs/kit';
import { browser } from '$app/environment';
import { buildOfflineDetail } from '$lib/client/media/offline-detail';
import type { MediaDetail, SeasonDetail } from '$lib/server/tmdb';
import type { PageLoad } from './$types';

/**
 * Universal load for the title page: fetch the detail via the `/api/title` route, streamed as a
 * promise so the page shows a skeleton while it resolves. When the API is unreachable (offline), fall
 * back to a copy rebuilt from IndexedDB so a tracked title still renders. Auth is checked up-front
 * from the (cached) layout data, so it stays offline-safe — no server round-trip on navigation.
 */
type TitleResult =
	| { status: 'ok'; detail: MediaDetail; season: SeasonDetail | null; offline: boolean }
	| { status: 'notfound' }
	| { status: 'unavailable' };

export const load: PageLoad = async ({ params, url, fetch, parent }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/login');

	const type = params.type === 'movie' || params.type === 'show' ? params.type : null;
	const id = Number(params.id);
	if (!type || !Number.isInteger(id) || id <= 0) error(404, 'Not found.');

	const season = url.searchParams.get('season');
	// Return the promise (not awaited) so SvelteKit streams it and the page can render a skeleton.
	return { content: loadTitle(fetch, type, id, season) };
};

async function loadTitle(
	fetch: typeof globalThis.fetch,
	type: 'movie' | 'show',
	id: number,
	season: string | null
): Promise<TitleResult> {
	const qs = season && season.trim() !== '' ? `?season=${encodeURIComponent(season)}` : '';
	try {
		const res = await fetch(`/api/title/${type}/${id}${qs}`);
		if (res.ok) {
			const data = (await res.json()) as { detail: MediaDetail; season: SeasonDetail | null };
			return { status: 'ok', detail: data.detail, season: data.season, offline: false };
		}
		// A real 404 is a missing title; other statuses (offline proxy / upstream) fall through to cache.
		if (res.status === 404) return { status: 'notfound' };
	} catch {
		// Network failure (offline) — fall through to the IndexedDB cache below.
	}

	if (browser) {
		const cached = await buildOfflineDetail(type, id, season);
		if (cached)
			return { status: 'ok', detail: cached.detail, season: cached.season, offline: true };
	}
	return { status: 'unavailable' };
}
