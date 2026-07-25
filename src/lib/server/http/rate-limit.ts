/**
 * A tiny, pure sliding-window rate limiter. Given the timestamps of a key's recent hits, it prunes
 * those outside the window, decides whether this hit is allowed, and returns the list to store back.
 * Kept dependency-free and clock-injected so it's fully unit-testable; the caller owns the store.
 *
 * Used for best-effort, per-isolate defense-in-depth on `/api/sync` (MRQ-109): the real backstop is
 * Cloudflare's edge rate-limiting, but this catches a looping/buggy client hammering one isolate.
 */
export interface RateLimitResult {
	/** True when this hit exceeds the window's cap and should be rejected. */
	limited: boolean;
	/** Seconds until the oldest hit ages out (>= 1) — the `Retry-After` value. 0 when not limited. */
	retryAfterSec: number;
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
