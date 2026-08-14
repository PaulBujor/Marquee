/**
 * Builds a {@link MediaRecord} for a user-authored entry — the mint site for custom media.
 *
 * Client-safe and pure (id and clock injectable), so the fan-out and the date derivation below are
 * testable without IndexedDB.
 */
import { todayIso } from '$lib/tracking/actions';
import type { MediaCredit, MediaEpisode, MediaRecord, MediaSeason } from '$lib/sync/events';
import type {
	CustomCreditInput,
	CustomMediaInput,
	CustomSeasonInput
} from '$lib/validation/custom-media';

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

/** Turn form credit rows into wire credits with billing order per role. */
function synthesizeCredits(input: CustomCreditInput[], mintPersonId: () => string): MediaCredit[] {
	const billing = new Map<string, number>();
	return input.map((c) => {
		const sortOrder = billing.get(c.role) ?? 0;
		billing.set(c.role, sortOrder + 1);
		const character = c.character.trim();
		return {
			personId: c.personId ?? mintPersonId(),
			externalId: null,
			name: c.name.trim(),
			profilePath: null,
			role: c.role,
			// Only cast play someone; the form hides the field for every other role.
			character: c.role === 'cast' && character !== '' ? character : null,
			sortOrder
		};
	});
}

/**
 * A complete media record for a new or edited custom entry. `id` is supplied for an edit, minted
 * randomly for a new one. `version: 0` marks it as never round-tripped through the server. Shows
 * are stamped `inProduction: false` so they can reach `completed`.
 */
export function createCustomMedia(
	input: CustomMediaInput,
	opts: { id?: string; now?: number; mintPersonId?: () => string } = {}
): MediaRecord {
	const now = opts.now ?? Date.now();
	const mintPersonId = opts.mintPersonId ?? (() => crypto.randomUUID());
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
		// The author is authoritative about their own entry, so `[]` (known-empty) rather than null:
		// a credit they removed has to actually clear, not read as "unknown, keep what's stored".
		credits: synthesizeCredits(input.credits, mintPersonId)
	};
}

/**
 * Recover the form input from a stored record, so editing an entry starts from what's there.
 * Seasons come back from the stored season rows, which carry the episode count directly; credits
 * keep their person ids, so re-saving credits the same people rather than minting fresh rows.
 */
export function toCustomMediaInput(
	record: Pick<MediaRecord, 'title' | 'type' | 'year' | 'overview'>,
	seasons: Pick<MediaSeason, 'seasonNumber' | 'episodeCount'>[],
	credits: MediaCredit[] = []
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
				: [],
		credits: [...credits]
			.sort((a, b) => a.role.localeCompare(b.role) || a.sortOrder - b.sortOrder)
			.map((c) => ({
				personId: c.personId,
				role: c.role,
				name: c.name,
				character: c.character ?? ''
			}))
	};
}
