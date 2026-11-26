/**
 * The handle record — the only thing the bridge stores. Everything else about a user lives in
 * their Stremio account, the per-handle Durable Object, or Marquee's D1: one owner per fact, so
 * no two copies can disagree.
 */

/** 32 random bytes as base64url: 256 bits. The handle is the only credential on the addon surface. */
const HANDLE_PATTERN = /^sbr_[A-Za-z0-9_-]{43}$/;

const key = (handle: string) => `handle:${handle}`;

export interface BridgeRecord {
	/** Bearer token for Marquee's `/api/v1`, minted by the user in Marquee's settings. */
	marqueeToken: string;
	/** Stremio's account `authKey` — the credential for `api.strem.io`. */
	stremioAuthKey: string;
	/** ISO timestamp of pairing. */
	createdAt: string;
}

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
