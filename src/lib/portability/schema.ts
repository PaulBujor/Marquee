/**
 * The on-disk contract for a data export — written by the export builder, read by the import
 * parser. A **library-level** document: one entry per tracked title carrying its end state, not a
 * dump of the event log. History is deliberately absent.
 *
 * Client-safe (no server imports).
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
	/** ISO 8601 — when the user marked it watched. */
	watchedAt: string;
}

/**
 * One tracked title.
 *
 * The metadata fields are **nullable together** — a tracking row can exist before its `media` row
 * synced, and dropping those would lose the user's data. Such an entry keeps only its `mediaId`.
 *
 * The clocks are load-bearing: import replays events stamped with them, so a restored library
 * keeps its real dates and last-write-wins can merge an old export into a newer account.
 */
export interface ExportedTitle {
	mediaId: string;
	provider: MediaProvider | null;
	/**
	 * The provider's own id, e.g. `show/95396`; null for custom media or an unhydrated entry. The
	 * portable identity anchor — `mediaId` derives from it, so an importer recomputes rather than
	 * trusting ours.
	 */
	externalId: string | null;
	type: 'movie' | 'show' | null;
	title: string | null;
	year: number | null;
	status: TrackingStatus;
	favorite: boolean;
	/** User rating 1–5; null = unrated. */
	rating: number | null;
	/** ISO 8601 — when the title joined the library. */
	addedAt: string;
	/**
	 * ISO 8601 — when the title last changed status. For a `completed` title that's when it was
	 * watched; for a show it's the fallback when no per-episode dates exist.
	 */
	statusChangedAt: string;
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
