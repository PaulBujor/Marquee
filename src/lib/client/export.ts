/**
 * Data export: read the device's offline replica and hand the user a JSON file.
 *
 * Deliberately network-free. IndexedDB is a full replica of the user's tracking data, so the
 * export is complete without the server — which is the point: if the service disappears, or the
 * user is simply offline, they can still take everything with them.
 *
 * Client-safe (browser only).
 */
import { getAllEpisodeWatches, getAllMedia, getTracking } from '$lib/client/idb';
import { buildExport } from '$lib/portability/build';
import { EXPORT_FILENAME_PREFIX, type MarqueeExport } from '$lib/portability/schema';

/** Gather local state into an export document. `now` is injectable so callers can pin the stamp. */
export async function collectExport(now: Date = new Date()): Promise<MarqueeExport> {
	const [tracking, media, watches] = await Promise.all([
		getTracking(), // already excludes removed (tombstoned) titles
		getAllMedia(),
		getAllEpisodeWatches()
	]);
	return buildExport({ tracking, media, watches, exportedAt: now });
}

/**
 * `marquee-export-2026-08-01.json` — dated so repeated exports don't overwrite each other.
 *
 * Uses the **local** calendar date, not UTC: someone exporting just after midnight should get
 * today's date in the filename, not yesterday's. (`exportedAt` inside the document stays UTC, as
 * an instant should.)
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
