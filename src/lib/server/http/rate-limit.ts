/**
 * A tiny, pure sliding-window rate limiter. Given the timestamps of a key's recent hits, it prunes
 * those outside the window, decides whether this hit is allowed, and returns the list to store back.
 * Kept dependency-free and clock-injected so it's fully unit-testable; the caller owns the store.
 *
 * Used for best-effort, per-isolate defense-in-depth on `/api/sync`: the real backstop is
 * Cloudflare's edge rate-limiting, but this catches a looping/buggy client hammering one isolate.
 */
export interface RateLimitResult {
	/** True when this hit exceeds the window's cap and should be rejected. */
	limited: boolean;
	/** Seconds until the oldest hit ages out (>= 1) — the `Retry-After` value. 0 when not limited. */
	retryAfterSec: number;
}

/**
 * Ask Cloudflare's limiter whether this request may proceed, for a key the caller has decided
 * identifies the caller: the client IP before we know who they are, the account afterwards. It fails
 * open — an anti-abuse backstop must not be what takes the app down — but a binding that is missing in
 * a deployed environment says so once per isolate, because "silently unlimited" is the one failure
 * that must not pass unnoticed.
 */
export async function withinRateLimit(
	env: Env | undefined,
	binding: 'PUBLIC_SHARE_LIMITER' | 'APP_RATE_LIMITER',
	key: string | null
): Promise<boolean> {
	// No bindings at all means build/prerender or a unit test, not a deployment missing a binding.
	if (!env) return true;

	const limiter = env[binding];
	if (!limiter) {
		warnOnce(`rate limit: ${binding} is not bound here — no limit is being applied`);
		return true;
	}

	if (!key) return true;

	try {
		return (await limiter.limit({ key })).success;
	} catch (err) {
		console.error('rate limit: binding failed', err);
		return true;
	}
}

const warned = new Set<string>();
function warnOnce(message: string): void {
	if (warned.has(message)) return;
	warned.add(message);
	console.warn(message);
}

/**
 * The budget key for a request we have not authenticated yet: the client IP, with IPv6 grouped by /64
 * because one host can rotate through its whole prefix for free. Deliberately **not** the session
 * cookie: this runs before `authentication`, so any cookie here is a value the caller chose, and keying
 * on it would hand an attacker a fresh budget with every request.
 */
export async function rateLimitKey(request: Request): Promise<string | null> {
	const ip = request.headers.get('cf-connecting-ip');
	if (!ip) return null;
	if (!ip.includes(':')) return `ip:${ip}`;

	// `::` expansion isn't worth resolving: any prefix of the written form still lands in the /64 for
	// the addresses a client actually rotates through, and this only decides who shares a budget.
	const groups = ip.split(':');
	return `ip:${groups.slice(0, 4).join(':')}::/64`;
}

/**
 * The budget key for a caller whose session we have verified: the account, so several people behind one
 * NAT don't spend each other's budget. A user id is not a credential, so it isn't hashed here.
 */
export function actorRateLimitKey(userId: string | undefined): string | null {
	return userId ? `user:${userId}` : null;
}

/**
 * Record that a request was shed, so abuse is visible early. Logged rather than counted: an Analytics
 * Engine binding is the documented way to count them, and declaring one was rejected at deploy on this
 * account. Connect one here when it's available.
 */
export function noteRateLimited(scope: 'app' | 'share', pathname: string): void {
	console.warn(`rate limit: shed ${scope} request for ${pathname}`);
}

/**
 * @param hits Timestamps (epoch ms) of prior hits for this key.
 * @param now Current time (epoch ms).
 * @param windowMs Length of the sliding window.
 * @param max Max hits allowed within the window.
 * @returns The decision plus the pruned timestamp list to persist back (this hit appended if allowed).
 */
export function slidingWindow(
	hits: number[],
	now: number,
	windowMs: number,
	max: number
): { result: RateLimitResult; kept: number[] } {
	const cutoff = now - windowMs;
	const kept = hits.filter((t) => t > cutoff);
	if (kept.length >= max) {
		const retryAfterSec = Math.max(1, Math.ceil((kept[0] + windowMs - now) / 1000));
		return { result: { limited: true, retryAfterSec }, kept };
	}
	kept.push(now);
	return { result: { limited: false, retryAfterSec: 0 }, kept };
}
