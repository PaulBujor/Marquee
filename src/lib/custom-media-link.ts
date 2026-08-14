/**
 * Accepting a match: the events that carry a custom entry's history onto the provider-backed title
 * it turned out to be.
 *
 * Linking **re-points, it never deletes**. The `media.linked` event records the association, the
 * user's state is re-emitted against the target so nothing is lost, and the custom entry's tracking
 * row is tombstoned so the library shows one title instead of two. Everything the user did against
 * the custom entry stays in the event log, and the entry itself stays on the device (custom rows are
 * never evicted), so it remains searchable and re-addable.
 *
 * Each re-emitted event carries the **original clock**, not now. Those clocks are the dates the app
 * displays — when a title joined the library, when it was finished, when each episode was ticked off
 * — so stamping them today would quietly rewrite the user's history into a single afternoon. It also
 * keeps last-write-wins honest if the target is already tracked on another device: a genuinely older
 * record should lose.
 *
 * Pure, so the whole merge is unit-testable without IndexedDB.
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
}

/**
 * A stored clock, or `now` when there isn't a usable one. A projection leaves a field's clock at 0
 * until something sets it, and the event schema rejects a non-positive clock — so an unset clock has
 * to become a real one rather than an event the server silently drops.
 */
function clockOr(stored: number, now: number): number {
	return stored > 0 ? stored : now;
}

/**
 * The ordered events that link `source` to `target`.
 *
 * Only state the user actually set is re-emitted. An unfavourited or unrated entry emits nothing for
 * those fields: the target's defaults already match, and emitting `favorite: false` would let a
 * merge *clear* a flag the user had set on the target from somewhere else. Linking should only ever
 * add to what the target knows.
 */
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

	// Retire the custom entry: unwatch its episodes, then tombstone it — the same order and reasoning
	// as removing a title by hand, so a replay can't resurrect the old progress. Both at `now`, so
	// they beat every clock above and the entry leaves the lists even though its history is older.
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
