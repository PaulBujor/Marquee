/** `media` store accessors — the client's cache of media reference data (title/poster/seasons). */
import { openDb, type ClientMedia } from './db';
import type { MediaProvider, MediaRecord } from '$lib/sync/events';

/** Upsert a media record (from a track-time capture or a channel pull). */
export async function putMedia(record: MediaRecord): Promise<void> {
	const db = await openDb();
	await db.put('media', { ...record, updatedAt: Date.now() });
}

/** A single cached media row, or undefined. */
export async function getMedia(id: string): Promise<ClientMedia | undefined> {
	return (await openDb()).get('media', id);
}

/** All cached media rows. */
export async function getAllMedia(): Promise<ClientMedia[]> {
	return (await openDb()).getAll('media');
}

/** Identity of locally-known provider-backed media, to push to the channel for server hydration. */
export async function getLinkedMediaRefs(): Promise<
	{ provider: MediaProvider; externalId: string }[]
> {
	const all = await getAllMedia();
	return all
		.filter((m) => m.source === 'linked' && m.externalId !== null)
		.map((m) => ({ provider: m.provider, externalId: m.externalId as string }));
}

/** Of the given media ids, those not present in the local cache. */
export async function getMissingMediaIds(ids: string[]): Promise<string[]> {
	const db = await openDb();
	const missing: string[] = [];
	for (const id of ids) {
		if (!(await db.get('media', id))) missing.push(id);
	}
	return missing;
}
