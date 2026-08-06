/**
 * A tracked title's displayed status, evaluated wherever it's read rather than cached at
 * write time. Movies have no signal finer than the intent itself (`status` on the tracking
 * row), so the derivation is identity for them. A show's `completed`/`watching` split is a
 * summary of episode-watch progress against aired episodes — the same completion sequence
 * `reconciledStatus` has always encoded — so unlike write-time reconciliation this recomputes
 * on every read and never depends on episode/production metadata having already arrived by
 * the time of some earlier write.
 */
import {
	airedEpisodes,
	isStillAiring,
	reconciledStatus,
	todayIso,
	watchedKey,
	type DatedEpisode,
	type TrackingRow,
	type TrackingView
} from './actions';
import type { TrackingStatus } from '$lib/sync/events';

/** The context `deriveStatus` needs beyond the projected status itself. */
export interface StatusDerivationContext {
	type: 'movie' | 'show';
	/** Per-episode air dates. Empty for movies, or for a show with no local episode data yet. */
	episodes: DatedEpisode[];
	/** Watched-episode keys (`"season:episode"`, see `watchedKey`). Empty for movies. */
	watched: ReadonlySet<string>;
	inProduction: boolean | null;
	today?: string;
}

export interface StatusDerivationInput extends StatusDerivationContext {
	/** The projected `tracking.status` — user intent, LWW from the event log. */
	projectedStatus: TrackingStatus;
}

/**
 * The status a title should display right now. A movie's projected status is returned as-is —
 * there's no finer-grained signal to check it against. A show's is corrected against aired
 * episodes actually watched; with no aired episodes to reconcile against (nothing's aired yet,
 * or episode data hasn't synced locally), the projected status is returned unchanged rather
 * than guessed at.
 */
export function deriveStatus(input: StatusDerivationInput): TrackingStatus {
	if (input.type === 'movie') return input.projectedStatus;
	const today = input.today ?? todayIso();
	const aired = airedEpisodes(input.episodes, today);
	if (aired.length === 0) return input.projectedStatus;
	const watchedCount = aired.filter((e) =>
		input.watched.has(watchedKey(e.season, e.episode))
	).length;
	const stillAiring = isStillAiring(input.episodes, input.inProduction, today);
	return (
		reconciledStatus(input.projectedStatus, watchedCount, aired.length, stillAiring) ??
		input.projectedStatus
	);
}

/** Collapse a local tracking row (or its absence) into a view, with status derived on read. */
export function toTrackingView(
	row: TrackingRow | undefined,
	context: StatusDerivationContext
): TrackingView {
	if (!row || row.removed) return { tracked: false };
	const status = deriveStatus({ ...context, projectedStatus: row.status });
	return { tracked: true, status, favorite: row.favorite, rating: row.rating };
}
