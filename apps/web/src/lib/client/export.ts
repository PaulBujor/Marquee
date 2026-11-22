import {
	getAllEpisodeWatches,
	getAllMedia,
	getCredits,
	getSeasons,
	getTracking
} from '#lib/client/idb/index.js';
import { buildExport } from '#lib/portability/build.js';
import {
	EXPORT_FILENAME_PREFIX,
	type ExportedCredit,
	type ExportedSeason,
	type MarqueeExport
} from '#lib/portability/schema.js';

/** `now` is injectable so callers can pin the stamp. */
export async function collectExport(now: Date = new Date()): Promise<MarqueeExport> {
	const [tracking, media, watches] = await Promise.all([
		getTracking(), // already excludes removed (tombstoned) titles
		getAllMedia(),
		getAllEpisodeWatches()
	]);

	// A user-authored show has no other source, so its seasons must travel in the file or the
	// watch history comes back pointing at episodes that no longer exist.
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

	// Same reasoning for cast and crew, and for movies too: these are names the user typed.
	const customCredits = new Map<string, ExportedCredit[]>(
		await Promise.all(
			media
				.filter((m) => m.source === 'custom')
				.map(async (m): Promise<[string, ExportedCredit[]]> => [
					m.id,
					(await getCredits(m.id)).map((c) => ({
						role: c.role,
						name: c.name,
						character: c.character,
						externalId: c.externalId
					}))
				])
		)
	);

	return buildExport({ tracking, media, watches, customSeasons, customCredits, exportedAt: now });
}

/** Uses the local calendar date; `exportedAt` inside the document stays UTC. */
export function exportFilename(now: Date = new Date()): string {
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	return `${EXPORT_FILENAME_PREFIX}-${now.getFullYear()}-${month}-${day}.json`;
}

/** Returns the number of titles written so the caller can confirm what happened. */
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
