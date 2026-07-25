/**
 * Reactive home-library read-model: loads the user's tracked titles from IndexedDB (tracking ⋈
 * media ⋈ episode-watches) into `LibraryItem`s for the dashboard + lists, and drives the
 * Continue Watching quick-mark. The page re-loads it on `sync.revision`.
 */
/* eslint-disable svelte/prefer-svelte-reactivity -- the Map/Sets here are transient locals rebuilt
   on each load(), never mutated in place; reactivity comes from reassigning `items`. */
import {
	getAllMedia,
	getEpisodeWatches,
	getEpisodes,
	getTracking,
	recordEvent
} from '$lib/client/idb';
import { watchedKey, type DatedEpisode } from './actions';
import { showProgress, type LibraryItem } from './library';
import { reconcileStatus } from './reconcile';
import { sync } from '$lib/client/sync/engine.svelte';

export class LibraryState {
	items = $state<LibraryItem[]>([]);
	ready = $state(false);
	busy = $state(false);

	/** Load all non-removed tracked titles joined with media + (for shows) episode metadata + watches. */
	async load(): Promise<void> {
		const [tracking, media] = await Promise.all([getTracking(), getAllMedia()]);
		const byId = new Map(media.map((m) => [m.id, m]));
		const items: LibraryItem[] = [];
		for (const t of tracking) {
			const m = byId.get(t.mediaId);
			const isShow = m?.type === 'show';
			let watched = new Set<string>();
			let episodes: DatedEpisode[] = [];
			if (isShow) {
				const [watches, eps] = await Promise.all([
					getEpisodeWatches(t.mediaId),
					getEpisodes(t.mediaId)
				]);
				watched = new Set(
					watches.filter((e) => e.watched).map((e) => watchedKey(e.season, e.episode))
				);
				episodes = eps.map((e) => ({ season: e.season, episode: e.episode, airDate: e.airDate }));
			}
			items.push({
				mediaId: t.mediaId,
				externalId: m?.externalId ?? null,
				status: t.status,
				favorite: t.favorite,
				rating: t.rating,
				addedAt: t.addedAt,
				type: m?.type ?? 'movie',
				title: m?.title ?? 'Loading…',
				year: m?.year ?? null,
				releaseDate: m?.releaseDate ?? null,
				posterPath: m?.posterPath ?? null,
				genres: m?.genres ?? [],
				inProduction: m?.inProduction ?? null,
				episodes,
				watched
			});
		}
		this.items = items;
		this.ready = true;
	}

	/** Mark a show's next episode watched from the dashboard, reconciling status + nudging sync. */
	async markNext(item: LibraryItem): Promise<void> {
		const progress = showProgress(item);
		if (!progress?.next || this.busy) return;
		this.busy = true;
		try {
			await recordEvent('episode.watched', item.mediaId, progress.next);
			// Pass episode air dates + production status so completion is derived from *aired*
			// episodes — matching the detail page (TrackingState) across both surfaces.
			await reconcileStatus(item.mediaId, item.episodes, item.inProduction);
			sync.requestSync();
			await this.load();
		} catch (err) {
			console.error(`markNext: write failed for ${item.mediaId}`, err);
		} finally {
			this.busy = false;
		}
	}
}
