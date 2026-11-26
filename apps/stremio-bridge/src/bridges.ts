/**
 * The handle record — the only thing the bridge stores. Everything else about a user lives in
 * their Stremio account, the per-handle Durable Object, or Marquee's D1: one owner per fact, so
 * no two copies can disagree.
 *
 * KV is the credential home permanently, not a staging area for the Durable Object that lands
 * with the reconcile — that owns the snapshot, the lock and the status, and only ever reads
 * these credentials.
 */

/** 32 random bytes as base64url: 256 bits. The handle is the only credential on the addon surface. */
const HANDLE_PATTERN = /^sbr_[A-Za-z0-9_-]{43}$/;

const key = (handle: string) => `handle:${handle}`;

export interface BridgeRecord {
	/** Bearer token for Marquee's `/api/v1`, minted by the user in Marquee's settings. */
	marqueeToken: string;
	/** Stremio's account `authKey` — the credential for `api.strem.io`. */
	stremioAuthKey: string;
	/**
	 * The Marquee this pairing was minted against, captured at pairing time rather than read from
	 * the Worker's env on every request: otherwise changing `MARQUEE_API_URL` would silently
	 * repoint every existing bridge at a host its token was never issued for.
	 */
	marqueeUrl: string;
	/** ISO timestamp of pairing. */
	createdAt: string;
	/**
	 * Set when Marquee rejected the stored token. The bridge keeps failing identically until someone
	 * pairs a new one, and this is the only place that state can live — so the configure page can say
	 * so instead of claiming the bridge is connected.
	 */
	authFailedAt?: string;
}

/** Enough to correlate log lines, too little to replay: the handle is a capability. */
export const shortHandle = (handle: string): string => `${handle.slice(0, 12)}…`;

export function newHandle(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);

	return `sbr_${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}

/** Rejects anything that is not a handle we could have minted, before it reaches KV. */
export const isHandle = (value: string): boolean => HANDLE_PATTERN.test(value);

export async function readBridge(kv: KVNamespace, handle: string): Promise<BridgeRecord | null> {
	return await kv.get<BridgeRecord>(key(handle), 'json');
}

export async function writeBridge(
	kv: KVNamespace,
	handle: string,
	record: BridgeRecord
): Promise<void> {
	await kv.put(key(handle), JSON.stringify(record));
}

export async function deleteBridge(kv: KVNamespace, handle: string): Promise<void> {
	await kv.delete(key(handle));
}
