import { redirect } from '@sveltejs/kit';
import { browser } from '$app/environment';
import { getCredits, getEpisodes, getMedia, getMediaLink, getSeasons } from '$lib/client/idb';
import type { PageLoad } from './$types';

/**
 * A custom entry lives only in the local store (and its owner-scoped backup), so this is a
 * universal load reading IndexedDB directly — there is no network copy to enrich it with, which is
 * why this route is separate from `/title/[type]/[id]` rather than a branch inside it.
 *
 * `entry` is null when the id names nothing local. That is a legitimate transient state on a fresh
 * device — the media channel may not have caught up with the event log yet — so the page says so
 * and offers a retry rather than hard-erroring on what will resolve itself.
 */
export const load: PageLoad = async ({ params, parent, depends }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/login');

	depends('app:custom-media'); // re-read after an edit, or once a sync brings the record down

	const empty = { id: params.id, entry: null, seasons: [], episodes: [], credits: [], link: null };
	if (!browser) return empty;

	const entry = (await getMedia(params.id)) ?? null;
	if (!entry || entry.source !== 'custom') return empty;

	const [seasons, episodes, credits, link] = await Promise.all([
		entry.type === 'show' ? getSeasons(params.id) : Promise.resolve([]),
		entry.type === 'show' ? getEpisodes(params.id) : Promise.resolve([]),
		getCredits(params.id),
		// The user's identity decision for this entry — whether they've dismissed match suggestions.
		getMediaLink(params.id).then((l) => l ?? null)
	]);

	return {
		id: params.id,
		entry,
		seasons: seasons.sort((a, b) => a.seasonNumber - b.seasonNumber),
		episodes: episodes.sort((a, b) => a.season - b.season || a.episode - b.episode),
		credits,
		link
	};
};
