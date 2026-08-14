/**
 * Build the detail-page view model from cached IndexedDB data when offline. Returns null when the
 * title isn't cached at all.
 */
import { getCredits, getEpisodes, getMedia, getSeasons } from '$lib/client/idb';
import type { ClientCredit, ClientEpisode } from '$lib/client/idb';
import { parsePersonExternalId, tmdbMediaId, type CreditRole } from '$lib/sync/events';
// Type-only import of the API contract shape — erased at build, so no server code reaches the client.
import type {
	CastMember,
	CrewMember,
	Episode,
	MediaDetail,
	Season,
	SeasonDetail
} from '$lib/server/tmdb';

export interface OfflineTitle {
	detail: MediaDetail;
	season: SeasonDetail | null;
}

/** Map cached episode rows for one season into the detail page's episode list, in order. */
export function offlineSeason(
	seasonNumber: number,
	name: string,
	overview: string,
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
	return { seasonNumber, name, overview, episodes };
}

/**
 * Split cached credits into the detail page's cast/crew shape. The page addresses a person by their
 * TMDB id (that's what `/person/[id]` takes), so a credit whose person we minted ourselves — no
 * provider id to link to — is left out rather than rendered as a dead link.
 */
export function offlineCredits(
	rows: ClientCredit[]
): Pick<MediaDetail, 'cast' | 'director' | 'writers' | 'producers' | 'creators'> {
	const cast: CastMember[] = [];
	const crew: Record<Exclude<CreditRole, 'cast'>, CrewMember[]> = {
		director: [],
		writer: [],
		producer: [],
		creator: []
	};
	for (const row of [...rows].sort((a, b) => a.sortOrder - b.sortOrder)) {
		const id = parsePersonExternalId(row.externalId);
		if (id === null) continue;
		if (row.role === 'cast') {
			cast.push({
				id,
				name: row.name,
				character: row.character ?? '',
				profilePath: row.profilePath
			});
		} else {
			crew[row.role].push({ id, name: row.name });
		}
	}
	return {
		cast,
		director: crew.director[0] ?? null,
		writers: crew.writer,
		producers: crew.producer,
		creators: crew.creator
	};
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
		...offlineCredits(await getCredits(id)),
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
		season = offlineSeason(
			chosen.seasonNumber,
			chosen.name,
			chosen.overview,
			await getEpisodes(id)
		);
	}

	return { detail, season };
}
