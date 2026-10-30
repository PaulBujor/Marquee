import { getCredits, getEpisodes, getMedia, getSeasons } from '#lib/client/idb/index.js';
import type { ClientCredit, ClientEpisode } from '#lib/client/idb/index.js';
import { parsePersonExternalId, tmdbMediaId, type CreditRole } from '#lib/sync/events.js';
// Type-only import of the API contract shape — erased at build, so no server code reaches the client.
import type {
	CastMember,
	CrewMember,
	Episode,
	MediaDetail,
	Season,
	SeasonDetail
} from '#lib/server/tmdb/index.js';

export interface OfflineTitle {
	detail: MediaDetail;
	season: SeasonDetail | null;
}

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

/** A credit with no provider person id is left out rather than rendered as a dead link. */
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

/** `seasonParam` mirrors the online `?season=N`; absent → first non-Specials season. */
export async function buildOfflineDetail(
	type: 'movie' | 'show',
	tmdbId: number,
	seasonParam?: string | null
): Promise<OfflineTitle | null> {
	try {
		return await assembleOfflineDetail(type, tmdbId, seasonParam);
	} catch {
		// Never throw from here: it runs inside the page `load`, and a throw would 500 the whole page.
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
