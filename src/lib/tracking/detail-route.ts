/**
 * Detail route for a title: provider-backed titles use `/title/[type]/[id]` (opens from provider id);
 * custom titles use `/custom/[id]`. Returns null when the title has no page yet (media not synced).
 */
import type { MediaSource } from '$lib/sync/events';
import { parseTmdbExternalId } from './media-record';

/** The minimum a row needs to carry to be addressable. */
export interface DetailTarget {
	mediaId: string;
	/** Null while the title's media row hasn't reached this device yet. */
	source: MediaSource | null;
	/** The provider's own id (e.g. `movie/603`); null for a custom entry or an unsynced one. */
	externalId: string | null;
}

export type DetailRoute =
	{ kind: 'title'; type: 'movie' | 'show'; id: string } | { kind: 'custom'; id: string };

/** The detail route for a title, or null when it has no page yet (media not synced). */
export function detailRoute(item: DetailTarget): DetailRoute | null {
	if (item.source === 'custom') {
		return item.mediaId ? { kind: 'custom', id: item.mediaId } : null;
	}
	if (item.externalId === null) return null;
	const ref = parseTmdbExternalId(item.externalId);
	return ref ? { kind: 'title', type: ref.type, id: String(ref.tmdbId) } : null;
}
