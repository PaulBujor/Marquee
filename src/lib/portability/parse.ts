/**
 * Reads an untrusted export file into a typed document — the client half of validate-on-both-sides.
 * Its job is a clear rejection reason before anything is written, *not* security: every event
 * import seeds is re-validated server-side by `eventEnvelopeSchema`.
 */
import { z } from 'zod';
import { CREDIT_ROLES, MEDIA_PROVIDERS, MEDIA_SOURCES, TRACKING_STATUSES } from '$lib/sync/events';
import {
	CUSTOM_MAX_CREDITS,
	CUSTOM_MAX_EPISODES_PER_SEASON,
	CUSTOM_MAX_SEASONS,
	CUSTOM_NAME_MAX,
	CUSTOM_OVERVIEW_MAX
} from '$lib/validation/custom-media';
import { EXPORT_FORMAT, EXPORT_SCHEMA_VERSION, type MarqueeExport } from './schema';

/** Why a file couldn't be read, mapped to a message in the UI. */
export type ParseFailure = 'not_json' | 'wrong_format' | 'unsupported_version' | 'invalid';

export type ParseResult = { ok: true; doc: MarqueeExport } | { ok: false; reason: ParseFailure };

// Season may be 0 (Specials); the episode within it is 1-based — matching the event schema.
const episodeSchema = z.object({
	season: z.number().int().nonnegative(),
	episode: z.number().int().positive(),
	watchedAt: z.string().min(1)
});

// Metadata fields are nullable as a group: an entry exported before its media row synced carries
// only an id. Rejecting those would discard the user's data on the way back in.
const titleSchema = z.object({
	mediaId: z.string().min(1),
	provider: z.enum(MEDIA_PROVIDERS).nullable(),
	externalId: z.string().min(1).nullable(),
	type: z.enum(['movie', 'show']).nullable(),
	title: z.string().nullable(),
	year: z.number().int().nullable(),
	// v2 additions, optional so a v1 file still reads (see EXPORT_SCHEMA_VERSION).
	source: z.enum(MEDIA_SOURCES).nullable().optional(),
	overview: z.string().max(CUSTOM_OVERVIEW_MAX).nullable().optional(),
	// Bounded to the same limits the authoring schema enforces. An import file is untrusted input,
	// and `planImport` fans `episodeCount` out into one object per episode *while the user is still
	// deciding whether to import* — an unbounded count freezes the tab on file selection alone. An
	// unbounded overview is quieter but never heals: it writes locally, then fails the push schema on
	// every sync cycle forever.
	seasons: z
		.array(
			z.object({
				seasonNumber: z.number().int().min(1).max(CUSTOM_MAX_SEASONS),
				episodeCount: z.number().int().nonnegative().max(CUSTOM_MAX_EPISODES_PER_SEASON)
			})
		)
		.max(CUSTOM_MAX_SEASONS)
		.nullable()
		.optional(),
	credits: z
		.array(
			z.object({
				role: z.enum(CREDIT_ROLES),
				name: z.string().min(1).max(CUSTOM_NAME_MAX),
				character: z.string().max(CUSTOM_NAME_MAX).nullable().optional(),
				externalId: z
					.string()
					.regex(/^person\/\d{1,12}$/)
					.nullable()
					.optional()
			})
		)
		.max(CUSTOM_MAX_CREDITS)
		.nullable()
		.optional(),
	status: z.enum(TRACKING_STATUSES),
	favorite: z.boolean(),
	rating: z.number().int().min(1).max(5).nullable(),
	addedAt: z.string().min(1),
	statusChangedAt: z.string().min(1),
	watchedEpisodes: z.array(episodeSchema)
});

/** Non-strict: an older client reads a newer file as long as the fields it knows about are intact. */
const documentSchema = z.object({
	format: z.literal(EXPORT_FORMAT),
	schemaVersion: z.number().int().positive(),
	exportedAt: z.string(),
	titleCount: z.number().int().nonnegative(),
	titles: z.array(titleSchema)
});

/** Parse export file text, returning either the typed document or why it was rejected. */
export function parseExport(text: string): ParseResult {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, reason: 'not_json' };
	}

	// Check the discriminator before the full schema, so picking the wrong file reads as
	// "that isn't a Marquee export" rather than a list of missing fields.
	if (
		typeof raw !== 'object' ||
		raw === null ||
		(raw as { format?: unknown }).format !== EXPORT_FORMAT
	) {
		return { ok: false, reason: 'wrong_format' };
	}
	if (Number((raw as { schemaVersion?: unknown }).schemaVersion) > EXPORT_SCHEMA_VERSION) {
		return { ok: false, reason: 'unsupported_version' };
	}

	const parsed = documentSchema.safeParse(raw);
	if (!parsed.success) return { ok: false, reason: 'invalid' };
	return { ok: true, doc: parsed.data as MarqueeExport };
}
