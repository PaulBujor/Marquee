const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A cryptographically random, URL-safe token (256 bits of entropy). Used as the
 * raw value in magic links and session cookies. Only ever stored hashed.
 */
export function generateToken(): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * A random 6-digit numeric code (for the PWA OTP flow). Uniform via rejection
 * sampling so no digit range is favoured; only ever stored hashed.
 */
export function generateCode(): string {
	const max = 1_000_000;
	const limit = Math.floor(0xffffffff / max) * max;
	let n: number;
	do {
		n = crypto.getRandomValues(new Uint32Array(1))[0];
	} while (n >= limit);
	return (n % max).toString().padStart(6, '0');
}

/**
 * SHA-256 of a token, hex-encoded. The hash is what we persist and look up by,
 * so a database read alone cannot reconstruct a usable token.
 */
export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
	return toHex(new Uint8Array(digest));
}
