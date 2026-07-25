/**
 * Pure read-model logic for the home dashboard: progress for shows, the Continue Watching
 * set, and list filtering/sorting. Movies and shows differ — only shows have progress and a
 * "next episode". `LibraryState` (`library.svelte.ts`) builds `LibraryItem`s from IndexedDB.
 */
import {
	airedEpisodes,
	nextEpisode,
	todayIso,
	watchedKey,
	type DatedEpisode,
	type EpisodeCoord
} from './actions';
import type { TrackingStatus } from '$lib/sync/events';

/** A tracked title joined with its media reference + episode metadata + episode-watch state. */
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
	/** `YYYY-MM-DD` release date (movies only), or null — feeds the upcoming timeline + date sort. */
	releaseDate: string | null;
	/** `YYYY-MM-DD` first air date (shows only), or null — the show equivalent for the date sort. */
	firstAirDate: string | null;
	posterPath: string | null;
	genres: string[];
	/** TMDB `in_production` — still-airing signal for completion; null for movies. */
	inProduction: boolean | null;
	/** Episode metadata (coords + air dates) — empty for movies / shows not yet synced. */
	episodes: DatedEpisode[];
	watched: Set<string>;
}

export type LibraryTab = 'want_to_watch' | 'watching' | 'completed' | 'favorites';
export type LibrarySort = 'title' | 'date' | 'added';

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

/** Watched/total + next episode for a show, or null for a movie / a show with no aired episodes. */
export function showProgress(item: LibraryItem, today: string = todayIso()): ShowProgress | null {
	if (item.type !== 'show') return null;
	const aired = airedEpisodes(item.episodes, today);
	if (aired.length === 0) return null;
	const watched = aired.filter((e) => item.watched.has(watchedKey(e.season, e.episode))).length;
	return {
		watched,
		total: aired.length,
		fraction: watched / aired.length,
		next: nextEpisode(item.episodes, item.watched, today)
	};
}

/** A single dated entry on the upcoming timeline — a future episode of a show, or a movie release. */
export interface UpcomingEntry {
	/** `YYYY-MM-DD` air/release date, strictly in the future. */
	date: string;
	mediaId: string;
	externalId: string | null;
	type: 'movie' | 'show';
	title: string;
	posterPath: string | null;
	kind: 'episode' | 'release';
	/** Set for `kind: 'episode'`. */
	season?: number;
	episode?: number;
}

/**
 * The upcoming-releases agenda (MRQ-65): future episodes of shows you're **watching**, merged with
 * release dates of **want-to-watch** movies, sorted ascending by date. Excludes Specials (season 0)
 * and anything already aired/released (date must be strictly after `today`). Other statuses
 * (completed / did-not-finish, and want-to-watch shows) don't contribute.
 */
export function filterUpcoming(items: LibraryItem[], today: string = todayIso()): UpcomingEntry[] {
	const out: UpcomingEntry[] = [];
	for (const item of items) {
		if (item.type === 'show') {
			if (item.status !== 'watching') continue;
			for (const ep of item.episodes) {
				if (ep.season === 0 || ep.airDate === null || ep.airDate <= today) continue;
				out.push({
					date: ep.airDate,
					mediaId: item.mediaId,
					externalId: item.externalId,
					type: 'show',
					title: item.title,
					posterPath: item.posterPath,
					kind: 'episode',
					season: ep.season,
					episode: ep.episode
				});
			}
		} else {
			if (item.status !== 'want_to_watch') continue;
			if (item.releaseDate === null || item.releaseDate <= today) continue;
			out.push({
				date: item.releaseDate,
				mediaId: item.mediaId,
				externalId: item.externalId,
				type: 'movie',
				title: item.title,
				posterPath: item.posterPath,
				kind: 'release'
			});
		}
	}
	// Lexicographic sort is correct for zero-padded `YYYY-MM-DD`.
	return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** In-progress shows (status watching, a next episode remaining) — the dashboard row. */
export function continueWatching(items: LibraryItem[]): LibraryItem[] {
	return items.filter((i) => {
		if (i.type !== 'show' || i.status !== 'watching') return false;
		return showProgress(i)?.next != null;
	});
}

/**
 * A sortable release date (`YYYY-MM-DD`): a movie's release date, a show's first air date, else
 * Jan 1 of the known year, else '' (unknown — sorts last under a newest-first order). Zero-padded,
 * so a plain string compare orders correctly.
 */
function releaseDateKey(item: LibraryItem): string {
	return (
		(item.type === 'movie' ? item.releaseDate : item.firstAirDate) ??
		(item.year !== null ? `${item.year}-01-01` : '')
	);
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
		// Newest release first; unknown dates ('') sort last.
		if (f.sort === 'date') return releaseDateKey(b).localeCompare(releaseDateKey(a));
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
