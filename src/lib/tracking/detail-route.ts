/**
 * Which detail page a title belongs on. The two kinds of media are addressed differently: a
 * provider-backed title by its provider id (so the page opens before anything is cached locally,
 * and a shared link keeps working), a user-authored one by our own id, since it exists nowhere but
 * this account.
 *
 * Returns the route's parts rather than a path, so the caller can run them through SvelteKit's
 * `resolve()` — and so this stays a pure decision, testable without the app's module graph.
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

/**
 * The detail route for a title, or **null when it has none yet** — a tracked title whose media
 * hasn't synced has no provider id to address and no local record to render. Callers render those
 * unlinked.
 */
export function detailRoute(item: DetailTarget): DetailRoute | null {
	if (item.source === 'custom') {
		return item.mediaId ? { kind: 'custom', id: item.mediaId } : null;
	}
	if (item.externalId === null) return null;
	const ref = parseTmdbExternalId(item.externalId);
	return ref ? { kind: 'title', type: ref.type, id: String(ref.tmdbId) } : null;
}
