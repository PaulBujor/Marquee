/**
 * Move a show's stored status in line with its episode progress (completion sequence, MRQ-55):
 * the last episode completes it, un-watching one un-completes it, the first watch starts it.
 *
 * This is an opportunistic cache-warm, not the source of truth for what's displayed — every read
 * path derives status live via `deriveStatus` (`./derive-status`), so a stale or absent write here
 * self-corrects on the next render with no further action needed. It still runs after episode
 * writes so a plain SQL query or the JSON export (which read the stored column directly, not
 * through `deriveStatus`) see a mostly-correct value; when the episode/production data it needs
 * hasn't synced locally yet, it just no-ops rather than guessing, same as `deriveStatus` does.
 */
import { getEpisodeWatches, getTrackingByMediaId, recordEvent } from '$lib/client/idb';
import {
	airedEpisodes,
	isAired,
	isStillAiring,
	reconciledStatus,
	todayIso,
	type DatedEpisode
} from './actions';

export async function reconcileStatus(
	mediaId: string,
	episodes: DatedEpisode[],
	inProduction: boolean | null = null,
	today: string = todayIso()
): Promise<void> {
	// Completion is measured against **aired** episodes, so a show counts as complete once every
	// released episode is watched (unaired episodes don't hold it back). A show that's still airing
	// (in production, or with announced-but-unaired episodes) stays "watching" even when caught up.
	const total = airedEpisodes(episodes, today).length;
	if (total === 0) return;
	const stillAiring = isStillAiring(episodes, inProduction, today);
	const row = await getTrackingByMediaId(mediaId);
	if (!row || row.removed) return;
	const watches = await getEpisodeWatches(mediaId);
	const airDates = airDatesByCoord(episodes);
	const watchedCount = watches.filter(
		(w) =>
			w.watched &&
			w.season >= 1 &&
			isAired({ airDate: airDates.get(`${w.season}:${w.episode}`) ?? null }, today)
	).length;
	const next = reconciledStatus(row.status, watchedCount, total, stillAiring);
	if (next) await recordEvent('tracking.status_changed', mediaId, { status: next });
}

/** Index episodes by `season:episode` so the watch-row scan below is linear, not quadratic. */
function airDatesByCoord(episodes: DatedEpisode[]): Map<string, string | null> {
	return new Map(episodes.map((e) => [`${e.season}:${e.episode}`, e.airDate]));
}
