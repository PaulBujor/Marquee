/**
 * Reads an untrusted export file into a typed document — the client half of validate-on-both-sides.
 * Its job is a clear rejection reason before anything is written, *not* security: every event
 * import seeds is re-validated server-side by `eventEnvelopeSchema`.
 */
import { z } from 'zod';
import { MEDIA_PROVIDERS, MEDIA_SOURCES, TRACKING_STATUSES } from '$lib/sync/events';
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
	overview: z.string().nullable().optional(),
	seasons: z
		.array(
			z.object({
				seasonNumber: z.number().int().nonnegative(),
				episodeCount: z.number().int().nonnegative()
			})
		)
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
