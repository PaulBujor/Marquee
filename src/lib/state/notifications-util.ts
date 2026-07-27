/** Pure helpers for the notifications rune — split out so they're unit-testable (the `.svelte.ts`
 * rune module can't be imported under the plain-node vitest config). */

/** Decode a base64url VAPID public key into the `applicationServerKey` bytes `subscribe()` wants. */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array {
	const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
	const base64 = (base64Url + padding).replaceAll('-', '+').replaceAll('_', '/');
	const raw = atob(base64);
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
	return bytes;
}

/** A short, human label for the settings device list, derived from the UA (best-effort). */
export function deviceLabel(userAgent: string | undefined): string {
	if (!userAgent) return 'This device';
	const browser = /Edg/.test(userAgent)
		? 'Edge'
		: /OPR|Opera/.test(userAgent)
			? 'Opera'
			: /Chrome/.test(userAgent)
				? 'Chrome'
				: /Firefox/.test(userAgent)
					? 'Firefox'
					: /Safari/.test(userAgent)
						? 'Safari'
						: 'Browser';
	const os = /Windows/.test(userAgent)
		? 'Windows'
		: /Android/.test(userAgent)
			? 'Android'
			: /iPhone|iPad|iPod/.test(userAgent)
				? 'iOS'
				: /Mac OS X/.test(userAgent)
					? 'macOS'
					: /Linux/.test(userAgent)
						? 'Linux'
						: '';
	return os ? `${browser} on ${os}` : browser;
}
