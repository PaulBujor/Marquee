/**
 * Move a show's status in line with its episode progress (completion sequence, MRQ-55): the last
 * episode completes it, un-watching one un-completes it, the first watch starts it. Needs the show's
 * episode air dates + production status (media reference data), so it runs where those are known and
 * records a `status_changed`. Shared by the detail page (`TrackingState`) and the dashboard quick-mark.
 */
import { getEpisodeWatches, getTrackingByMediaId, recordEvent } from '$lib/client/idb';
import {
	airedEpisodes,
	isAired,
	isStillAiring,
	reconciledStatus,
	todayIso,
	type EpisodeAir
} from './actions';

export async function reconcileStatus(
	mediaId: string,
	episodes: EpisodeAir[],
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
	const watchedCount = watches.filter(
		(w) =>
			w.watched &&
			w.season >= 1 &&
			isAired({ airDate: airDateOf(episodes, w.season, w.episode) }, today)
	).length;
	const next = reconciledStatus(row.status, watchedCount, total, stillAiring);
	if (next) await recordEvent('tracking.status_changed', mediaId, { status: next });
}

/** The air date of a given episode coord in the reference list, or null if unknown. */
function airDateOf(episodes: EpisodeAir[], season: number, episode: number): string | null {
	return episodes.find((e) => e.season === season && e.episode === episode)?.airDate ?? null;
}
