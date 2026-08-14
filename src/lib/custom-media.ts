/**
 * Builds a {@link MediaRecord} for a user-authored entry — the mint site for custom media.
 *
 * Client-safe and pure (id and clock injectable), so the fan-out and the date derivation below are
 * testable without IndexedDB.
 */
import { todayIso } from '$lib/tracking/actions';
import type { MediaEpisode, MediaRecord, MediaSeason } from '$lib/sync/events';
import type { CustomMediaInput, CustomSeasonInput } from '$lib/validation/custom-media';

/**
 * The air date every synthesized episode gets. Null means unannounced/unaired, which makes the
 * episode unwatchable — wrong for a custom entry the user says exists. A real past date makes
 * watchability work unchanged. Clamped to today if the year is in the future.
 */
export function customEpisodeAirDate(year: number | null, now: number = Date.now()): string {
	const today = todayIso(now);
	if (year === null) return today;
	const candidate = `${String(year).padStart(4, '0')}-01-01`;
	return candidate <= today ? candidate : today;
}

/** Fan a season's episode count out into individual episodes, all sharing the entry's air date. */
function synthesizeEpisodes(seasons: CustomSeasonInput[], airDate: string): MediaEpisode[] {
	const out: MediaEpisode[] = [];
	for (const season of seasons) {
		for (let episode = 1; episode <= season.episodeCount; episode++) {
			out.push({
				season: season.seasonNumber,
				episode,
				// The form collects a count, not per-episode detail; the UI falls back to "Episode N".
				name: '',
				overview: '',
				airDate,
				runtime: null,
				stillPath: null
			});
		}
	}
	return out;
}

function synthesizeSeasons(seasons: CustomSeasonInput[], airDate: string): MediaSeason[] {
	return seasons.map((s) => ({
		seasonNumber: s.seasonNumber,
		name: `Season ${s.seasonNumber}`,
		overview: '',
		airDate,
		posterPath: null,
		episodeCount: s.episodeCount
	}));
}

/**
 * A complete media record for a new or edited custom entry. `id` is supplied for an edit, minted
 * randomly for a new one. `version: 0` marks it as never round-tripped through the server. Shows
 * are stamped `inProduction: false` so they can reach `completed`.
 */
export function createCustomMedia(
	input: CustomMediaInput,
	opts: { id?: string; now?: number } = {}
): MediaRecord {
	const now = opts.now ?? Date.now();
	const isShow = input.type === 'show';
	const airDate = customEpisodeAirDate(input.year, now);
	const seasons = [...input.seasons].sort((a, b) => a.seasonNumber - b.seasonNumber);

	return {
		id: opts.id ?? crypto.randomUUID(),
		provider: 'local',
		externalId: null,
		source: 'custom',
		type: input.type,
		title: input.title.trim(),
		year: input.year,
		posterPath: null,
		backdropPath: null,
		overview: input.overview.trim(),
		genres: [],
		releaseDate: null,
		// TMDB's own production status; there is none for a title TMDB has never seen.
		status: null,
		inProduction: isShow ? false : null,
		firstAirDate: null,
		lastAirDate: null,
		version: 0,
		seasons: isShow ? synthesizeSeasons(seasons, airDate) : null,
		episodes: isShow ? synthesizeEpisodes(seasons, airDate) : null
	};
}

/**
 * Recover the form input from a stored record, so editing an entry starts from what's there.
 * Seasons come back from the stored season rows, which carry the episode count directly.
 */
export function toCustomMediaInput(
	record: Pick<MediaRecord, 'title' | 'type' | 'year' | 'overview'>,
	seasons: Pick<MediaSeason, 'seasonNumber' | 'episodeCount'>[]
): CustomMediaInput {
	return {
		title: record.title,
		type: record.type,
		year: record.year,
		overview: record.overview,
		seasons:
			record.type === 'show'
				? seasons
						.map((s) => ({ seasonNumber: s.seasonNumber, episodeCount: s.episodeCount }))
						.sort((a, b) => a.seasonNumber - b.seasonNumber)
				: []
	};
}
