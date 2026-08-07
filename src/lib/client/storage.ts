/**
 * Best-effort persistent storage. Ask the browser to keep our IndexedDB — the event queue,
 * media cache, and image blobs — from being evicted under storage pressure, and expose a rough usage
 * estimate for the settings data/cache card. All feature-detected: unsupported browsers (e.g. older
 * iOS) simply no-op. Storage is tighter on iOS (~50 MB/origin), so persistence + pruning matter most
 * there.
 */

/** Request persistent storage so the browser won't evict our offline data. Returns whether granted. */
export async function requestPersistentStorage(): Promise<boolean> {
	if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
	try {
		// Already granted? Avoid a redundant request on browsers that gate it behind a heuristic.
		if (await navigator.storage.persisted?.()) return true;
		return await navigator.storage.persist();
	} catch {
		return false;
	}
}

export interface StorageUsage {
	/** Bytes currently used by this origin. */
	usage: number;
	/** Total bytes available to this origin (best-effort; browsers fuzz it). */
	quota: number;
}

/** A rough usage/quota estimate for this origin, or null when the API is unavailable. */
export async function estimateStorage(): Promise<StorageUsage | null> {
	if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
	try {
		const { usage = 0, quota = 0 } = await navigator.storage.estimate();
		return { usage, quota };
	} catch {
		return null;
	}
}
