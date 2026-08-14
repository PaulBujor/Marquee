/** Data export: read the device's offline replica and produce a JSON file. Network-free. */
import { getAllEpisodeWatches, getAllMedia, getSeasons, getTracking } from '$lib/client/idb';
import { buildExport } from '$lib/portability/build';
import {
	EXPORT_FILENAME_PREFIX,
	type ExportedSeason,
	type MarqueeExport
} from '$lib/portability/schema';

/** Gather local state into an export document. `now` is injectable so callers can pin the stamp. */
export async function collectExport(now: Date = new Date()): Promise<MarqueeExport> {
	const [tracking, media, watches] = await Promise.all([
		getTracking(), // already excludes removed (tombstoned) titles
		getAllMedia(),
		getAllEpisodeWatches()
	]);

	// Custom show seasons must travel in the file — they have no other source on import.
	const customShows = media.filter((m) => m.source === 'custom' && m.type === 'show');
	const customSeasons = new Map<string, ExportedSeason[]>(
		await Promise.all(
			customShows.map(async (m): Promise<[string, ExportedSeason[]]> => [
				m.id,
				(await getSeasons(m.id))
					.map((s) => ({ seasonNumber: s.seasonNumber, episodeCount: s.episodeCount }))
					.sort((a, b) => a.seasonNumber - b.seasonNumber)
			])
		)
	);

	return buildExport({ tracking, media, watches, customSeasons, exportedAt: now });
}

/**
 * `marquee-export-2026-08-01.json` — dated so repeated exports don't overwrite each other. Uses
 * the **local** calendar date: exporting just after midnight should give today, not yesterday.
 * (`exportedAt` inside the document stays UTC, as an instant should.)
 */
export function exportFilename(now: Date = new Date()): string {
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	return `${EXPORT_FILENAME_PREFIX}-${now.getFullYear()}-${month}-${day}.json`;
}

/**
 * Build the export and save it via a synthetic download link. Returns the number of titles
 * written so the caller can confirm what happened.
 */
export async function downloadExport(): Promise<number> {
	const now = new Date();
	const doc = await collectExport(now);
	// Pretty-printed: the file is meant to be readable, and it compresses away in transit anyway.
	const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = exportFilename(now);
	// Firefox only dispatches a synthetic click on an element that's in the document.
	link.style.display = 'none';
	document.body.appendChild(link);
	try {
		link.click();
	} finally {
		link.remove();
		// Safari needs the URL to outlive the click; a task turn is enough, then it can be reclaimed.
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}
	return doc.titleCount;
}
