/**
 * Public surface of the client offline store. UI code produces a tracking change
 * via {@link recordEvent}, which writes through the event pipeline from day one:
 * it enqueues the event in the outbox (for the sync engine to push, MRQ-43) *and*
 * applies it to the local materialized stores optimistically.
 */
import { enqueueEvent } from './outbox';
import { applyEventToIdb } from './state';
import { getDeviceId } from './meta';
import { createEvent, type EventPayloadMap, type SyncEventType } from '$lib/sync/events';

export { openDb } from './db';
export type {
	ClientMedia,
	ClientTracking,
	ClientEpisodeWatch,
	UpcomingEpisode,
	MarqueeDatabase
} from './db';
export { getUnsynced, markSynced, enqueueEvent } from './outbox';
export { applyEventToIdb, getTracking, getTrackingByMediaId, getEpisodeWatches } from './state';
export { getDeviceId, getCursor, setCursor, getUserId, setUserId } from './meta';

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
