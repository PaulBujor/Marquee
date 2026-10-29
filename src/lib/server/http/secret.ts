/** Constant-time comparison for the cron routes — `!==` short-circuits and leaks how long a shared prefix was. */

const encoder = new TextEncoder();

/** Both sides are hashed first so the loop bound can't leak the expected secret's length. */
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

/** False when the secret isn't configured, so a missing binding fails closed rather than accepting every caller. */
export async function isAuthorizedCronRequest(
	request: Request,
	secret: string | undefined
): Promise<boolean> {
	if (!secret) return false;
	const presented = request.headers.get('x-cron-key');
	if (presented === null) return false;
	return timingSafeEqual(presented, secret);
}
