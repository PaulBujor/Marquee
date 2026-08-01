/**
 * The on-disk contract for a Marquee data export — the shared shape both directions of data
 * portability speak: the export builder writes it, the import parser reads it.
 *
 * It is a **library-level** document, not a dump of the event log or the IndexedDB stores: one
 * entry per tracked title, carrying the end-state a user would recognise (status, rating,
 * favorite, which episodes they've seen). History is deliberately absent — the file records what
 * you have, not the sequence of edits that got you there.
 *
 * Client-safe (no server imports), so it can be read from anywhere in the app.
 */
import type { MediaProvider, TrackingStatus } from '$lib/sync/events';

/** Discriminator written into every file, so a foreign JSON can be rejected before parsing it. */
export const EXPORT_FORMAT = 'marquee-export';

/** Bumped when the document shape changes. Import refuses versions it doesn't understand. */
export const EXPORT_SCHEMA_VERSION = 1;

/** Filename stem for a downloaded export; the date and extension are appended. */
export const EXPORT_FILENAME_PREFIX = 'marquee-export';

/** A single episode a user has watched. Season 0 is TMDB's Specials. */
export interface ExportedEpisode {
	season: number;
	episode: number;
}

/**
 * One tracked title.
 *
 * The metadata fields are **nullable together**: a tracking row can exist with no `media` row
 * behind it (a title added offline before the media channel pulled it), and dropping those on
 * export would lose the user's data. Such an entry keeps its `mediaId` and nothing else.
 *
 * Two fields carry weight beyond display. `externalId` is the portable identity anchor —
 * `mediaId` is a deterministic UUIDv5 of `(provider, externalId)`, so an importer re-derives the
 * id rather than trusting ours. And `addedAt` is the round-trip clock: import stamps its events
 * with it, which both restores the original "date added" and lets last-write-wins merge an old
 * export into a newer account without clobbering it.
 */
export interface ExportedTitle {
	mediaId: string;
	provider: MediaProvider | null;
	/** The provider's own id, e.g. `show/95396`; null for custom media or an unhydrated entry. */
	externalId: string | null;
	type: 'movie' | 'show' | null;
	title: string | null;
	year: number | null;
	status: TrackingStatus;
	favorite: boolean;
	/** User rating 1–5; null = unrated. */
	rating: number | null;
	/** ISO 8601. */
	addedAt: string;
	/** Empty for movies, and for shows with nothing watched. */
	watchedEpisodes: ExportedEpisode[];
}

/** A complete export document. */
export interface MarqueeExport {
	format: typeof EXPORT_FORMAT;
	schemaVersion: number;
	/** ISO 8601 instant the file was produced. */
	exportedAt: string;
	/** Mirrors `titles.length` — a readable at-a-glance count for whoever opens the file. */
	titleCount: number;
	titles: ExportedTitle[];
}
