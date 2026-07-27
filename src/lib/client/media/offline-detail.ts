/**
 * Build the detail-page view model from cached IndexedDB data when the title API is unreachable
 * (offline). We only hold reference data locally — title, overview, artwork, genres, dates, and a
 * show's seasons/episodes — so the degraded {@link MediaDetail} nulls out the fields that only live
 * on TMDB (rating, runtime, cast, crew, trailer, similar); the page shows an offline placeholder for
 * those. Returns null when the title isn't cached at all (never opened / tracked on this device).
 */
import { getEpisodes, getMedia, getSeasons } from '$lib/client/idb';
import type { ClientEpisode } from '$lib/client/idb';
import { tmdbMediaId } from '$lib/sync/events';
// Type-only import of the API contract shape — erased at build, so no server code reaches the client.
import type { Episode, MediaDetail, Season, SeasonDetail } from '$lib/server/tmdb';

export interface OfflineTitle {
	detail: MediaDetail;
	season: SeasonDetail | null;
}

/** Map cached episode rows for one season into the detail page's episode list, in order. */
export function offlineSeason(
	seasonNumber: number,
	name: string,
	episodeRows: ClientEpisode[]
): SeasonDetail {
	const episodes: Episode[] = episodeRows
		.filter((e) => e.season === seasonNumber)
		.sort((a, b) => a.episode - b.episode)
		.map((e) => ({
			episodeNumber: e.episode,
			name: e.name,
			airDate: e.airDate,
			overview: e.overview,
			stillPath: e.stillPath,
			runtime: e.runtime
		}));
	return { seasonNumber, name, episodes };
}

/**
 * Assemble an offline detail view for a TMDB title from IndexedDB, or null if it isn't cached.
 * `seasonParam` mirrors the online `?season=N` selection; absent → first non-Specials season.
 */
export async function buildOfflineDetail(
	type: 'movie' | 'show',
	tmdbId: number,
	seasonParam?: string | null
): Promise<OfflineTitle | null> {
	try {
		return await assembleOfflineDetail(type, tmdbId, seasonParam);
	} catch {
		// Store not ready (e.g. the active user isn't scoped yet on an early load) or a read failed —
		// no offline base; the page renders its skeleton and enriches from the network instead. Never
		// throw from here: it runs inside the page `load`, and a throw would 500 the whole page.
		return null;
	}
}

async function assembleOfflineDetail(
	type: 'movie' | 'show',
	tmdbId: number,
	seasonParam?: string | null
): Promise<OfflineTitle | null> {
	const id = tmdbMediaId(type, tmdbId);
	const m = await getMedia(id);
	if (!m) return null;

	const seasonRows = (await getSeasons(id)).sort((a, b) => a.seasonNumber - b.seasonNumber);
	const seasons: Season[] = seasonRows.map((s) => ({
		seasonNumber: s.seasonNumber,
		name: s.name,
		episodeCount: s.episodeCount,
		airDate: s.airDate,
		posterPath: s.posterPath,
		overview: s.overview
	}));

	const detail: MediaDetail = {
		tmdbId,
		type,
		title: m.title,
		year: m.year,
		overview: m.overview,
		posterPath: m.posterPath,
		backdropPath: m.backdropPath,
		// TMDB-only fields we don't cache — shown as an offline placeholder on the page.
		rating: null,
		voteCount: 0,
		runtime: null,
		genres: m.genres ?? [],
		cast: [],
		director: null,
		writers: [],
		producers: [],
		creators: [],
		trailer: null,
		releaseDate: m.releaseDate,
		status: m.status,
		inProduction: m.inProduction,
		firstAirDate: m.firstAirDate,
		lastAirDate: m.lastAirDate,
		seasons,
		similar: []
	};

	let season: SeasonDetail | null = null;
	if (type === 'show' && seasons.length > 0) {
		const requested = seasonParam && seasonParam.trim() !== '' ? Number(seasonParam) : NaN;
		const chosen =
			seasons.find((s) => s.seasonNumber === requested) ??
			seasons.find((s) => s.seasonNumber >= 1) ??
			seasons[0];
		season = offlineSeason(chosen.seasonNumber, chosen.name, await getEpisodes(id));
	}

	return { detail, season };
}
