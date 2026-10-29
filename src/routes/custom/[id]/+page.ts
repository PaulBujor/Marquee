import { redirect } from '@sveltejs/kit';
import { browser } from '$app/env';
import {
	getCredits,
	getEpisodes,
	getMedia,
	getMediaLink,
	getSeasons
} from '#lib/client/idb/index.js';
import { detailRoute } from '#lib/tracking/detail-route.js';
import type { PageLoad } from './$types';

/** `entry` is legitimately null on a fresh device until the media channel catches up, so the page retries rather than erroring. */
export const load: PageLoad = async ({ params, parent, depends }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/login');

	depends('app:custom-media'); // re-read after an edit, or once a sync brings the record down

	const empty = {
		id: params.id,
		entry: null,
		seasons: [],
		episodes: [],
		credits: [],
		link: null,
		linkedTo: null
	};
	if (!browser) return empty;

	const entry = (await getMedia(params.id)) ?? null;
	if (!entry || entry.source !== 'custom') return empty;

	const [seasons, episodes, credits, link] = await Promise.all([
		entry.type === 'show' ? getSeasons(params.id) : Promise.resolve([]),
		entry.type === 'show' ? getEpisodes(params.id) : Promise.resolve([]),
		getCredits(params.id),
		getMediaLink(params.id).then((l) => l ?? null)
	]);

	// Reachable after a link (Back, a stale tab), so it must say "already matched" rather than offer the match again.
	const target = link?.targetId ? ((await getMedia(link.targetId)) ?? null) : null;

	return {
		id: params.id,
		entry,
		seasons: seasons.sort((a, b) => a.seasonNumber - b.seasonNumber),
		episodes: episodes.sort((a, b) => a.season - b.season || a.episode - b.episode),
		credits,
		link,
		linkedTo:
			link?.targetId === undefined || link?.targetId === null
				? null
				: {
						id: link.targetId,
						title: target?.title ?? null,
						route: detailRoute({
							mediaId: link.targetId,
							source: target?.source ?? 'linked',
							externalId: target?.externalId ?? link.externalId
						})
					}
	};
};
