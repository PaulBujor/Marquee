import { enqueueEvent, enqueueEvents } from './outbox';
import { applyEventToIdb, applyEventsToIdb } from './state';
import { getDeviceId } from './meta';
import { createEvent, type EventPayloadMap, type SyncEventType } from '#lib/sync/events.js';

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

/** `clock` is only for replaying an event that happened earlier; omit it to stamp now. */
export type EventSpec = {
	[T in SyncEventType]: {
		type: T;
		entityId: string;
		payload: EventPayloadMap[T];
		clock?: number;
	};
}[SyncEventType];

/** One transaction per phase — 250 episodes through `recordEvent` is 500 sequential round trips. */
export async function recordEvents(specs: EventSpec[]): Promise<void> {
	if (specs.length === 0) return;
	const deviceId = await getDeviceId();
	const events = specs.map((s) => createEvent(s.type, s.entityId, s.payload, deviceId, s.clock));
	await enqueueEvents(events);
	await applyEventsToIdb(events);
}
