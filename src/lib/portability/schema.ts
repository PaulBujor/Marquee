/**
 * On-disk contract for a data export. A library-level document: one entry per tracked title, not
 * an event log. Client-safe.
 */
import type { MediaProvider, MediaSource, TrackingStatus } from '$lib/sync/events';

/** Discriminator written into every file, so a foreign JSON can be rejected before parsing it. */
export const EXPORT_FORMAT = 'marquee-export';

/**
 * Bumped when the document shape changes. Import refuses unknown versions. v2 added `source`,
 * `overview` and `seasons` for custom media round-trips; v1 files still import.
 */
export const EXPORT_SCHEMA_VERSION = 2;

/** Filename stem for a downloaded export; the date and extension are appended. */
export const EXPORT_FILENAME_PREFIX = 'marquee-export';

/** A season of a user-authored show — enough to rebuild its episode list on import. */
export interface ExportedSeason {
	seasonNumber: number;
	episodeCount: number;
}

/** A single episode a user has watched. Season 0 is TMDB's Specials. */
export interface ExportedEpisode {
	season: number;
	episode: number;
	/** ISO 8601 — when the user marked it watched. */
	watchedAt: string;
}

/**
 * One tracked title. Metadata fields are nullable — a tracking row can exist before its `media`
 * row synced. Clocks are load-bearing: import replays events stamped with them.
 */
export interface ExportedTitle {
	mediaId: string;
	provider: MediaProvider | null;
	/** Provider's own id; null for custom media. The portable identity anchor — importers recompute `mediaId` from it. */
	externalId: string | null;
	type: 'movie' | 'show' | null;
	title: string | null;
	year: number | null;
	/** Provider-backed or custom. Absent in v1 files. */
	source?: MediaSource | null;
	/** The user's own description. Only carried for custom entries — provider text is re-fetched. */
	overview?: string | null;
	/** A custom show's seasons; absent for movies and for provider-backed titles. */
	seasons?: ExportedSeason[] | null;
	status: TrackingStatus;
	favorite: boolean;
	/** User rating 1–5; null = unrated. */
	rating: number | null;
	/** ISO 8601 — when the title joined the library. */
	addedAt: string;
	/** ISO 8601 — when the title last changed status. */
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
