/**
 * Constant-time secret comparison for request-authenticated endpoints (the cron routes).
 *
 * A plain `!==` short-circuits on the first differing character, so its runtime leaks how long a
 * shared prefix was. Over the public internet that signal is buried in network jitter and this is
 * not a practical attack — but the fix is three lines, and the habit matters more where a future
 * comparison might be reachable over a lower-noise path.
 */

const encoder = new TextEncoder();

/**
 * Whether two secrets match, in time independent of *where* they differ.
 *
 * Both sides are hashed first so the comparison always runs over equal-length input: comparing raw
 * strings would still leak the length of the expected secret through the loop bound.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const [da, db] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(a)),
		crypto.subtle.digest('SHA-256', encoder.encode(b))
	]);
	const va = new Uint8Array(da);
	const vb = new Uint8Array(db);
	let diff = 0;
	for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
	return diff === 0;
}

/**
 * Validate a cron request's `x-cron-key` against `CRON_SECRET`. False when the secret isn't
 * configured, so a missing binding fails closed rather than accepting every caller.
 */
export async function isAuthorizedCronRequest(
	request: Request,
	secret: string | undefined
): Promise<boolean> {
	if (!secret) return false;
	const presented = request.headers.get('x-cron-key');
	if (presented === null) return false;
	return timingSafeEqual(presented, secret);
}
