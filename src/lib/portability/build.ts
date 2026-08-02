/**
 * Assembles an export document from the client's materialized state. Pure — every input, including
 * the clock, is injected — so it unit-tests without IndexedDB and produces byte-identical output for
 * identical state.
 */
import type { ClientEpisodeWatch, ClientMedia, ClientTracking } from '$lib/client/idb';
import {
	EXPORT_FORMAT,
	EXPORT_SCHEMA_VERSION,
	type ExportedEpisode,
	type ExportedTitle,
	type MarqueeExport
} from './schema';

export interface ExportInput {
	/** Non-removed tracking rows; tombstones are filtered upstream by `getTracking()`. */
	tracking: ClientTracking[];
	media: ClientMedia[];
	/** Every watch row, watched or not — this filters them. */
	watches: ClientEpisodeWatch[];
	exportedAt: Date;
}

/**
 * Fixed locale, not the device's. Collation is locale-dependent — Swedish orders 'ä' after 'z'
 * where English orders it with 'a' — so sorting by the device default would make the same library
 * export in a different order on a different phone, and two exports stop diffing cleanly.
 */
const collator = new Intl.Collator('en', { sensitivity: 'variant' });

/** Order titles the way a reader expects, so two exports of the same state diff cleanly. */
function compareTitles(a: ExportedTitle, b: ExportedTitle): number {
	// Entries with no media row yet have no name to sort by, so they collect at the end.
	if (a.title === null || b.title === null) {
		if (a.title !== b.title) return a.title === null ? 1 : -1;
		return collator.compare(a.mediaId, b.mediaId);
	}
	return collator.compare(a.title, b.title) || collator.compare(a.mediaId, b.mediaId);
}

function compareEpisodes(a: ExportedEpisode, b: ExportedEpisode): number {
	return a.season - b.season || a.episode - b.episode;
}

/**
 * An epoch-ms clock as an ISO string, falling back when the value isn't a usable date.
 *
 * `new Date(x).toISOString()` throws a `RangeError` on `NaN` or `undefined`, so a single corrupt
 * or missing clock — a row written by an older schema version, say — would otherwise abort the
 * whole export. Losing one date is recoverable; losing the ability to get your data out is not.
 */
function isoClock(value: number | undefined, fallback: Date): string {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback.toISOString();
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString();
}

/** Build the export document for a user's library. */
export function buildExport(input: ExportInput): MarqueeExport {
	const mediaById = new Map(input.media.map((m) => [m.id, m]));

	const watchedByMedia = new Map<string, ExportedEpisode[]>();
	for (const w of input.watches) {
		// `watched: false` rows are retained locally as last-write-wins tombstones, not history.
		if (!w.watched) continue;
		const list = watchedByMedia.get(w.mediaId);
		// The row's LWW clock is the clock of the `episode.watched` event — i.e. when it was marked.
		const episode = {
			season: w.season,
			episode: w.episode,
			watchedAt: isoClock(w.updatedAt, input.exportedAt)
		};
		if (list) list.push(episode);
		else watchedByMedia.set(w.mediaId, [episode]);
	}

	const titles = input.tracking.map((t): ExportedTitle => {
		const m = mediaById.get(t.mediaId);
		const addedAt = isoClock(t.addedAt, input.exportedAt);
		// A row that only ever saw a favorite/rating event keeps the initial 0 clock, which would
		// export as 1970. Nothing changes status before it was added, so the add is the floor.
		const statusChangedAt = isoClock(t.statusUpdatedAt, input.exportedAt);
		return {
			mediaId: t.mediaId,
			provider: m?.provider ?? null,
			externalId: m?.externalId ?? null,
			type: m?.type ?? null,
			title: m?.title ?? null,
			year: m?.year ?? null,
			status: t.status,
			favorite: t.favorite,
			rating: t.rating,
			addedAt,
			statusChangedAt: statusChangedAt < addedAt ? addedAt : statusChangedAt,
			watchedEpisodes: (watchedByMedia.get(t.mediaId) ?? []).sort(compareEpisodes)
		};
	});
	titles.sort(compareTitles);

	return {
		format: EXPORT_FORMAT,
		schemaVersion: EXPORT_SCHEMA_VERSION,
		exportedAt: input.exportedAt.toISOString(),
		titleCount: titles.length,
		titles
	};
}
