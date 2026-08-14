import { redirect } from '@sveltejs/kit';
import { browser } from '$app/environment';
import { getEpisodes, getMedia, getSeasons } from '$lib/client/idb';
import type { PageLoad } from './$types';

/**
 * Custom entries live only in the local store, so this reads IndexedDB directly. `entry` is null
 * when the id names nothing local (transient on a fresh device — the page offers a retry).
 */
export const load: PageLoad = async ({ params, parent, depends }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/login');

	depends('app:custom-media'); // re-read after an edit, or once a sync brings the record down

	if (!browser) return { id: params.id, entry: null, seasons: [], episodes: [] };

	const entry = (await getMedia(params.id)) ?? null;
	if (!entry || entry.source !== 'custom') {
		return { id: params.id, entry: null, seasons: [], episodes: [] };
	}
	const [seasons, episodes] =
		entry.type === 'show'
			? await Promise.all([getSeasons(params.id), getEpisodes(params.id)])
			: [[], []];

	return {
		id: params.id,
		entry,
		seasons: seasons.sort((a, b) => a.seasonNumber - b.seasonNumber),
		episodes: episodes.sort((a, b) => a.season - b.season || a.episode - b.episode)
	};
};
