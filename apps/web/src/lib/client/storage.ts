/** Storage is tighter on iOS (~50 MB/origin), so persistence and pruning matter most there. */

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
	/** Total bytes available (best-effort; browsers fuzz it). */
	quota: number;
}

export async function estimateStorage(): Promise<StorageUsage | null> {
	if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
	try {
		const { usage = 0, quota = 0 } = await navigator.storage.estimate();
		return { usage, quota };
	} catch {
		return null;
	}
}
