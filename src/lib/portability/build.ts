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

/** Order titles the way a reader expects, so two exports of the same state diff cleanly. */
function compareTitles(a: ExportedTitle, b: ExportedTitle): number {
	// Entries with no media row yet have no name to sort by, so they collect at the end.
	if (a.title === null || b.title === null) {
		if (a.title !== b.title) return a.title === null ? 1 : -1;
		return a.mediaId.localeCompare(b.mediaId);
	}
	return a.title.localeCompare(b.title) || a.mediaId.localeCompare(b.mediaId);
}

function compareEpisodes(a: ExportedEpisode, b: ExportedEpisode): number {
	return a.season - b.season || a.episode - b.episode;
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
			watchedAt: new Date(w.updatedAt).toISOString()
		};
		if (list) list.push(episode);
		else watchedByMedia.set(w.mediaId, [episode]);
	}

	const titles = input.tracking.map((t): ExportedTitle => {
		const m = mediaById.get(t.mediaId);
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
			addedAt: new Date(t.addedAt).toISOString(),
			statusChangedAt: new Date(t.statusUpdatedAt).toISOString(),
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
