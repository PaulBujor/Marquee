/**
 * Shape and bounds for a user-authored ("custom") media entry — one definition validated on both
 * sides, per the convention: the create/edit form parses against it for immediate feedback, and the
 * media channel re-validates every pushed record with it server-side, where the answer is
 * authoritative.
 *
 * Client-safe (no server imports).
 */
import { z } from 'zod';
import { CREDIT_ROLES } from '$lib/sync/events';

export const CUSTOM_TITLE_MAX = 200;
/**
 * A synopsis someone typed themselves. Sized against what a real one looks like — a provider's own
 * overview runs a few hundred characters — with room to spare, rather than against what the column
 * would tolerate. Every custom record travels whole on the media channel, so this is also what caps
 * a push — `MEDIA_SYNC_CUSTOM_MAX` records carrying one of these each.
 */
export const CUSTOM_OVERVIEW_MAX = 1000;
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

/** Predates any film. */
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

/**
 * One credited person as the form collects them: a role, a name, and (for cast) who they played.
 *
 * `personId` is absent the first time a name is entered and minted on save. It comes *back* on an
 * edit so re-saving keeps crediting the same person rather than minting a fresh row each time —
 * which would orphan the old one and break the "everything this person worked on" lookup.
 *
 * `externalId` and `profilePath` are set when the author picked someone out of search instead of
 * typing a bare name — a record of who they meant, not a link. The person is still stored as their
 * own private row. Both are null offline, where there is nobody to search.
 */
export const customCreditInputSchema = z.object({
	personId: z.uuid().optional(),
	role: z.enum(CREDIT_ROLES),
	name: z.string().trim().min(1).max(CUSTOM_NAME_MAX),
	character: z.string().trim().max(CUSTOM_NAME_MAX),
	// Optional as well as nullable: everything that builds this input without a search behind it —
	// an import, a test, the form before anyone picks anyone — simply omits them.
	externalId: z
		.string()
		.regex(/^person\/\d{1,12}$/)
		.nullable()
		.optional(),
	profilePath: z
		.string()
		.regex(/^\/[A-Za-z0-9._-]{1,128}$/)
		.nullable()
		.optional()
});

export type CustomCreditInput = z.infer<typeof customCreditInputSchema>;

/** Case-insensitive `role + name`, the pair a person can only be credited under once. */
function creditKey(credit: { role: string; name: string }): string {
	return `${credit.role}:${credit.name.trim().toLowerCase()}`;
}

/** Everything the create/edit form collects. */
export const customMediaInputSchema = z
	.object({
		title: z.string().trim().min(1).max(CUSTOM_TITLE_MAX),
		type: z.enum(['movie', 'show']),
		year: z.number().int().min(CUSTOM_MIN_YEAR).max(CUSTOM_MAX_YEAR).nullable(),
		// Trimmed like the title, so the value the form validates is the value that gets stored.
		overview: z.string().trim().max(CUSTOM_OVERVIEW_MAX),
		seasons: z.array(customSeasonInputSchema).max(CUSTOM_MAX_SEASONS),
		credits: z.array(customCreditInputSchema).max(CUSTOM_MAX_CREDITS)
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
	})
	// `(person, role)` is the primary key on both sides, so a duplicate would silently collapse on
	// save. Rejecting it here says so instead of quietly dropping a row the user typed.
	.refine((v) => new Set(v.credits.map(creditKey)).size === v.credits.length, {
		message: 'Each person can only be credited once per role.',
		path: ['credits']
	});

export type CustomMediaInput = z.infer<typeof customMediaInputSchema>;

/** Episodes across every season — the bound that matters, and what the form shows as a running total. */
export function totalEpisodes(seasons: CustomSeasonInput[]): number {
	return seasons.reduce((n, s) => n + s.episodeCount, 0);
}
