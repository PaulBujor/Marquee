/**
 * The events that link a custom entry to a provider-backed title: re-point the user's history
 * without deleting anything. Pure and unit-testable.
 */
import type { EventSpec } from '$lib/client/idb';
import type { HydratableProvider, TrackingStatus } from '$lib/sync/events';

/** The custom entry's tracking row, as the local projection holds it. */
export interface LinkSourceTracking {
	mediaId: string;
	status: TrackingStatus;
	favorite: boolean;
	rating: number | null;
	addedAt: number;
	statusUpdatedAt: number;
	favoriteUpdatedAt: number;
	ratingUpdatedAt: number;
}

/** One of the custom entry's episode-watch rows. */
export interface LinkSourceWatch {
	season: number;
	episode: number;
	watched: boolean;
	updatedAt: number;
}

/** The provider-backed title the user accepted. */
export interface LinkTarget {
	/** Our media id for the target, derived from `(provider, externalId)`. */
	targetId: string;
	provider: HydratableProvider;
	externalId: string;
	/**
	 * The target's own `removedUpdatedAt`, when this device holds a tracking row for it — 0 when it
	 * has never been tracked or removed here. See {@link buildLinkEvents} for why the merge needs it.
	 */
	removedUpdatedAt?: number;
}

/** Clamp a stored clock to a positive integer, falling back to `now` for unset (0) clocks. */
function clockOr(stored: number, now: number): number {
	return stored > 0 ? stored : now;
}

/** Ordered events that link `source` to `target`. Only re-emits state the user actually set. */
export function buildLinkEvents(
	source: LinkSourceTracking,
	watches: LinkSourceWatch[],
	target: LinkTarget,
	now: number = Date.now()
): EventSpec[] {
	const events: EventSpec[] = [
		{
			type: 'media.linked',
			entityId: source.mediaId,
			payload: {
				targetId: target.targetId,
				provider: target.provider,
				externalId: target.externalId
			},
			clock: now
		},
		// Stamped with when the title joined the library, which is what `addedAt` means on both sides
		// (the server floors it to the earliest `tracking.*` clock it has seen for the row).
		{
			type: 'tracking.added',
			entityId: target.targetId,
			payload: { status: source.status },
			clock: clockOr(source.addedAt, now)
		},
		// The add above already set the status; this carries *when* it was last set, which is the
		// "watched" date a completed title displays.
		{
			type: 'tracking.status_changed',
			entityId: target.targetId,
			payload: { status: source.status },
			clock: clockOr(source.statusUpdatedAt, now)
		}
	];

	if (source.favorite) {
		events.push({
			type: 'tracking.favorite_toggled',
			entityId: target.targetId,
			payload: { favorite: true },
			clock: clockOr(source.favoriteUpdatedAt, now)
		});
	}
	if (source.rating !== null) {
		events.push({
			type: 'tracking.rated',
			entityId: target.targetId,
			payload: { rating: source.rating },
			clock: clockOr(source.ratingUpdatedAt, now)
		});
	}

	const watched = watches.filter((w) => w.watched);
	for (const w of watched) {
		events.push({
			type: 'episode.watched',
			entityId: target.targetId,
			payload: { season: w.season, episode: w.episode },
			clock: clockOr(w.updatedAt, now)
		});
	}

	const addedClock = clockOr(source.addedAt, now);
	const tombstone = target.removedUpdatedAt ?? 0;
	if (tombstone > addedClock) {
		events.push({
			type: 'tracking.added',
			entityId: target.targetId,
			payload: { status: source.status },
			clock: tombstone
		});
	}

	// Retire the custom entry: unwatch, then tombstone — both at `now` so they beat every clock above.
	for (const w of watched) {
		events.push({
			type: 'episode.unwatched',
			entityId: source.mediaId,
			payload: { season: w.season, episode: w.episode },
			clock: now
		});
	}
	events.push({ type: 'tracking.removed', entityId: source.mediaId, payload: {}, clock: now });

	return events;
}
