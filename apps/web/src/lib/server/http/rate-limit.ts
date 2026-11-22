/** Best-effort, per-isolate defense-in-depth; the real backstop is Cloudflare's edge rate limiting. */
export interface RateLimitResult {
	limited: boolean;
	/** Seconds until the oldest hit ages out (>= 1) — the `Retry-After` value. 0 when not limited. */
	retryAfterSec: number;
}

/** Fails open on purpose, but a binding missing in a deployment says so once per isolate. */
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

/** Deliberately **not** the session cookie: this runs before `authentication`, so any cookie here is caller-chosen. */
export async function rateLimitKey(request: Request): Promise<string | null> {
	const ip = request.headers.get('cf-connecting-ip');
	if (!ip) return null;
	if (!ip.includes(':')) return `ip:${ip}`;

	// `::` expansion isn't worth resolving: any prefix of the written form still lands in the /64 a
	// client actually rotates through.
	const groups = ip.split(':');
	return `ip:${groups.slice(0, 4).join(':')}::/64`;
}

/** The budget key for a verified caller: the account, so several people behind one NAT don't share a budget. */
export function actorRateLimitKey(userId: string | undefined): string | null {
	return userId ? `user:${userId}` : null;
}

/** Logged, not counted: declaring an Analytics Engine binding was rejected at deploy on this account. */
export function noteRateLimited(scope: 'app' | 'share', pathname: string): void {
	console.warn(`rate limit: shed ${scope} request for ${pathname}`);
}

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
