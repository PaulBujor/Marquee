/**
 * Move a show's status in line with its episode progress (completion sequence, MRQ-55): the last
 * episode completes it, un-watching one un-completes it, the first watch starts it. Needs the
 * total episode count (media reference data), so it runs where that's known and records a
 * `status_changed`. Shared by the detail page (`TrackingState`) and the dashboard quick-mark.
 */
import { getEpisodeWatches, getTrackingByMediaId, recordEvent } from '$lib/client/idb';
import { allEpisodes, reconciledStatus, type SeasonCounts } from './actions';

export async function reconcileStatus(mediaId: string, seasons: SeasonCounts[]): Promise<void> {
	const total = allEpisodes(seasons).length;
	if (total === 0) return;
	const row = await getTrackingByMediaId(mediaId);
	if (!row || row.removed) return;
	const episodes = await getEpisodeWatches(mediaId);
	const watchedCount = episodes.filter((e) => e.watched && e.season >= 1).length;
	const next = reconciledStatus(row.status, watchedCount, total);
	if (next) await recordEvent('tracking.status_changed', mediaId, { status: next });
}
