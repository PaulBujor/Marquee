/**
 * Shape and bounds for a user-authored ("custom") media entry — one definition validated on both
 * sides, per the convention: the create/edit form parses against it for immediate feedback, and the
 * media channel re-validates every pushed record with it server-side, where the answer is
 * authoritative.
 *
 * Client-safe (no server imports).
 */
import { z } from 'zod';

export const CUSTOM_TITLE_MAX = 200;
export const CUSTOM_OVERVIEW_MAX = 2000;
export const CUSTOM_MAX_SEASONS = 50;
export const CUSTOM_MAX_EPISODES_PER_SEASON = 200;
/**
 * Across all seasons. Every episode becomes a row on both sides, and a link replays one event per
 * watched episode, so the total is what actually needs bounding — not just the per-season count.
 */
export const CUSTOM_MAX_EPISODES_TOTAL = 2000;

/**
 * Credited people on one entry, across every role. Generous enough for a full unit-production
 * list typed by hand, small enough that a push stays one modest request.
 */
export const CUSTOM_MAX_CREDITS = 100;
/** A person's name — much shorter than a title, and long enough for any real one. */
export const CUSTOM_NAME_MAX = 120;

/** Roughly the first films (Roundhay Garden Scene, 1888), with room to spare. */
export const CUSTOM_MIN_YEAR = 1870;
/**
 * A fixed ceiling rather than "this year + N": a schema whose bounds move with the clock can't be
 * tested deterministically, and nothing downstream depends on the limit being tight. Air dates for
 * a future-dated entry are clamped where they're derived, not here.
 */
export const CUSTOM_MAX_YEAR = 2200;

/** A season of a custom show. The user gives it a number and how many episodes it has — nothing else. */
export const customSeasonInputSchema = z.object({
	seasonNumber: z.number().int().min(1).max(CUSTOM_MAX_SEASONS),
	episodeCount: z.number().int().min(0).max(CUSTOM_MAX_EPISODES_PER_SEASON)
});

export type CustomSeasonInput = z.infer<typeof customSeasonInputSchema>;

/** Everything the create/edit form collects. */
export const customMediaInputSchema = z
	.object({
		title: z.string().trim().min(1).max(CUSTOM_TITLE_MAX),
		type: z.enum(['movie', 'show']),
		year: z.number().int().min(CUSTOM_MIN_YEAR).max(CUSTOM_MAX_YEAR).nullable(),
		overview: z.string().max(CUSTOM_OVERVIEW_MAX),
		seasons: z.array(customSeasonInputSchema).max(CUSTOM_MAX_SEASONS)
	})
	.refine((v) => v.type === 'show' || v.seasons.length === 0, {
		message: 'A movie has no seasons.',
		path: ['seasons']
	})
	.refine((v) => new Set(v.seasons.map((s) => s.seasonNumber)).size === v.seasons.length, {
		message: 'Season numbers must be unique.',
		path: ['seasons']
	})
	.refine((v) => totalEpisodes(v.seasons) <= CUSTOM_MAX_EPISODES_TOTAL, {
		message: `A show can have at most ${CUSTOM_MAX_EPISODES_TOTAL} episodes.`,
		path: ['seasons']
	});

export type CustomMediaInput = z.infer<typeof customMediaInputSchema>;

/** Episodes across every season — the bound that matters, and what the form shows as a running total. */
export function totalEpisodes(seasons: CustomSeasonInput[]): number {
	return seasons.reduce((n, s) => n + s.episodeCount, 0);
}
