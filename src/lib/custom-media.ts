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
 * Turn the form's credit rows into wire credits, numbering each role's billing from the order the
 * user arranged them in. A person the entry doesn't credit yet gets an id minted here — random for
 * the same reason the media id is, and private to this user.
 *
 * `externalId`/`profilePath` carry through only when the author picked someone out of search. They
 * record *who was meant*; the minted id is still what identifies the person, so a custom entry never
 * claims the provider's row.
 */
function synthesizeCredits(input: CustomCreditInput[], mintPersonId: () => string): MediaCredit[] {
	const billing = new Map<string, number>();
	return input.map((c) => {
		const sortOrder = billing.get(c.role) ?? 0;
		billing.set(c.role, sortOrder + 1);
		const character = c.character.trim();
		return {
			personId: c.personId ?? mintPersonId(),
			externalId: c.externalId ?? null,
			name: c.name.trim(),
			profilePath: c.profilePath ?? null,
			role: c.role,
			// Only cast play someone; the form hides the field for every other role.
			character: c.role === 'cast' && character !== '' ? character : null,
			sortOrder
		};
	});
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
				character: c.character ?? '',
				externalId: c.externalId,
				profilePath: c.profilePath
			}))
	};
}
