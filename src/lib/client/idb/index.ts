/**
 * Public surface of the client offline store. UI code produces a tracking change
 * via {@link recordEvent}, which writes through the event pipeline from day one:
 * it enqueues the event in the outbox (for the sync engine to push) *and*
 * applies it to the local materialized stores optimistically.
 */
import { enqueueEvent, enqueueEvents } from './outbox';
import { applyEventToIdb, applyEventsToIdb } from './state';
import { getDeviceId } from './meta';
import { createEvent, type EventPayloadMap, type SyncEventType } from '$lib/sync/events';

export { openDb, setActiveUser, wipeLocalData } from './db';
export type {
	ClientMedia,
	ClientSeason,
	ClientEpisode,
	ClientCredit,
	ClientTracking,
	ClientEpisodeWatch,
	ClientMediaLink,
	MarqueeDatabase
} from './db';
export { getUnsynced, markSynced, enqueueEvent, enqueueEvents } from './outbox';
export {
	applyEventToIdb,
	applyEventsToIdb,
	getTracking,
	getTrackingByMediaId,
	getMediaLink,
	getMediaLinksTo,
	getEpisodeWatches,
	getAllEpisodeWatches
} from './state';
export {
	putMedia,
	putMediaBatch,
	putCustomMedia,
	getMedia,
	getAllMedia,
	searchLocalMedia,
	searchCustomMedia,
	getSeasons,
	getEpisodes,
	getCredits,
	getCreditsForPerson,
	getLinkedMediaRefs,
	getMediaVersions,
	getReferencedMediaIds,
	getUnsyncedMediaIds,
	getPendingCustomMedia,
	clearPendingPush,
	pruneStaleMedia,
	deleteLocalMedia
} from './media';
export {
	getDeviceId,
	getCursor,
	setCursor,
	getLastSyncAt,
	setLastSyncAt,
	getLastFullMediaCheck,
	setLastFullMediaCheck,
	getRecentSearches,
	addRecentSearch,
	clearRecentSearches
} from './meta';

/**
 * Record a local tracking change: stamp it as an event, enqueue it for sync, and
 * apply it to local state. `entityId` is the target `mediaId` (see `mediaId()`).
 */
export async function recordEvent<T extends SyncEventType>(
	type: T,
	entityId: string,
	payload: EventPayloadMap[T]
): Promise<void> {
	const deviceId = await getDeviceId();
	const event = createEvent(type, entityId, payload, deviceId);
	await enqueueEvent(event);
	await applyEventToIdb(event);
}

/**
 * One event to record, for {@link recordEvents}.
 *
 * `clock` overrides the stamp, and should be passed only when replaying something that genuinely
 * happened earlier — carrying a title's history onto the entry it was matched to, say. Left off,
 * the event is stamped now, which is what a live user action wants.
 */
export type EventSpec = {
	[T in SyncEventType]: {
		type: T;
		entityId: string;
		payload: EventPayloadMap[T];
		clock?: number;
	};
}[SyncEventType];

/**
 * Record many local changes in **two** transactions rather than two per event.
 *
 * `recordEvent` opens one transaction to enqueue and another to project, which is right for a
 * single user action but wrong for a bulk one: marking a 250-episode series watched runs 500
 * sequential IndexedDB round trips with the UI blocked behind them. The import path already
 * batches for exactly this reason (`enqueueEvents` / `applyEventsToIdb`); this gives the bulk
 * tracking actions the same treatment.
 */
export async function recordEvents(specs: EventSpec[]): Promise<void> {
	if (specs.length === 0) return;
	const deviceId = await getDeviceId();
	const events = specs.map((s) => createEvent(s.type, s.entityId, s.payload, deviceId, s.clock));
	await enqueueEvents(events);
	await applyEventsToIdb(events);
}
