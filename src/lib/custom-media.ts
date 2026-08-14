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
 * The air date every synthesized episode of a custom show gets.
 *
 * It cannot be null. A null air date means *unannounced or not yet aired* — `isAired` reads it that
 * way, and so does everything built on it: an episode with no date is unwatchable, contributes no
 * progress, is never the "next episode", and is skipped by "mark season watched". That's the right
 * reading for TMDB data we simply don't have yet, but for a custom entry the user is asserting the
 * episode exists. Giving it a real past date makes every one of those helpers work unchanged, and
 * keeps the entry off the upcoming timeline, which only shows dates in the future.
 *
 * The entry's year is the honest choice where there is one. A year in the future would put the date
 * ahead of today and make the episodes unwatchable again, so it's clamped.
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
 * A complete media record for a new or edited custom entry.
 *
 * `id` is supplied for an edit and minted randomly for a new one — random rather than derived,
 * because there is no `(provider, externalId)` to derive from and a private entry must not have an
 * id anyone else could compute. `version: 0` marks it as never having been round-tripped through
 * the server, exactly as a quick-add snapshot does.
 *
 * A show is stamped `inProduction: false` so it can reach `completed`: `isStillAiring` keeps a show
 * with unaired episodes in `watching`, and the user has told us the whole thing, so there is
 * nothing still to come.
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
		episodes: isShow ? synthesizeEpisodes(seasons, airDate) : null,
		// The author is authoritative about their own entry, so `[]` (known-empty) rather than null.
		// Populated once the form collects credits.
		credits: []
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
