/**
 * Pure read-model logic for the home dashboard: progress for shows, the Continue Watching
 * set, and list filtering/sorting. Movies and shows differ — only shows have progress and a
 * "next episode". `LibraryState` (`library.svelte.ts`) builds `LibraryItem`s from IndexedDB.
 */
import {
	airedEpisodes,
	nextEpisode,
	watchedKey,
	type EpisodeCoord,
	type SeasonCounts
} from './actions';
import type { TrackingStatus } from '$lib/sync/events';

/** A tracked title joined with its media reference + episode-watch state. */
export interface LibraryItem {
	mediaId: string;
	/** Provider external id (e.g. `movie/603`) — the detail-page route key; null for custom media. */
	externalId: string | null;
	status: TrackingStatus;
	favorite: boolean;
	rating: number | null;
	addedAt: number;
	type: 'movie' | 'show';
	title: string;
	year: number | null;
	posterPath: string | null;
	genres: string[];
	seasons: SeasonCounts[] | null;
	lastAired: EpisodeCoord | null;
	watched: Set<string>;
}

export type LibraryTab = 'want_to_watch' | 'watching' | 'completed' | 'favorites';
export type LibrarySort = 'title' | 'year' | 'added';

export interface LibraryFilters {
	tab: LibraryTab;
	type: 'all' | 'movie' | 'show';
	year: number | null;
	genre: string | null;
	sort: LibrarySort;
}

export interface ShowProgress {
	watched: number;
	total: number;
	fraction: number;
	next: EpisodeCoord | null;
}

/** Watched/total + next episode for a show, or null for a movie / a show with no episodes. */
export function showProgress(item: LibraryItem): ShowProgress | null {
	if (item.type !== 'show' || !item.seasons) return null;
	const episodes = airedEpisodes(item.seasons, item.lastAired);
	if (episodes.length === 0) return null;
	const watched = episodes.filter((c) => item.watched.has(watchedKey(c.season, c.episode))).length;
	return {
		watched,
		total: episodes.length,
		fraction: watched / episodes.length,
		next: nextEpisode(item.seasons, item.watched, item.lastAired)
	};
}

/** In-progress shows (status watching, a next episode remaining) — the dashboard row. */
export function continueWatching(items: LibraryItem[]): LibraryItem[] {
	return items.filter((i) => {
		if (i.type !== 'show' || i.status !== 'watching') return false;
		return showProgress(i)?.next != null;
	});
}

/** Apply the tab + type/year/genre filters and the chosen sort. `favorites` spans all statuses. */
export function filterAndSortLibrary(items: LibraryItem[], f: LibraryFilters): LibraryItem[] {
	const filtered = items.filter((i) => {
		if (f.tab === 'favorites') {
			if (!i.favorite) return false;
		} else if (i.status !== f.tab) {
			return false;
		}
		if (f.type !== 'all' && i.type !== f.type) return false;
		if (f.year !== null && i.year !== f.year) return false;
		if (f.genre !== null && !i.genres.includes(f.genre)) return false;
		return true;
	});

	return filtered.sort((a, b) => {
		if (f.sort === 'title') return a.title.localeCompare(b.title);
		if (f.sort === 'year') return (b.year ?? 0) - (a.year ?? 0);
		return b.addedAt - a.addedAt;
	});
}

/** Distinct release years across items, newest first. */
export function availableYears(items: LibraryItem[]): number[] {
	const years = new Set<number>();
	for (const i of items) if (i.year !== null) years.add(i.year);
	return [...years].sort((a, b) => b - a);
}

/** Distinct genres across items, alphabetical. */
export function availableGenres(items: LibraryItem[]): string[] {
	const genres = new Set<string>();
	for (const i of items) for (const g of i.genres) genres.add(g);
	return [...genres].sort((a, b) => a.localeCompare(b));
}
