/**
 * Pure decision logic for the sync engine's per-cycle media gate and full-check watermark —
 * extracted from `engine.svelte.ts` so this trigger logic is unit-testable independent of the rune
 * singleton.
 */

/**
 * How often the media channel does a *full* version-diff pass (every referenced id, not just ones
 * missing locally) — the only way to notice a title the nightly cron refreshed server-side while
 * this device already had a copy. Much slower than the event-sync interval on purpose: nothing
 * about a sub-day poll cadence can usefully chase a 12h TTL.
 */
export const FULL_MEDIA_CHECK_MS = 15 * 60 * 1000;

/** Whether the full version-diff pass is due, given when it last ran. */
export function isFullMediaCheckDue(lastFullMediaCheck: number, now: number): boolean {
	return now - lastFullMediaCheck >= FULL_MEDIA_CHECK_MS;
}

/**
 * Whether the media channel should run this cycle: the event channel pulled something new (the
 * only way a title's local-missing status can have changed since last cycle), or the full-check
 * cadence is due.
 */
export function shouldRunMediaSync(
	pulled: number,
	lastFullMediaCheck: number,
	now: number
): boolean {
	return pulled > 0 || isFullMediaCheckDue(lastFullMediaCheck, now);
}

/**
 * The next `lastFullMediaCheck` watermark. Only advances when a full check was due *and* the media
 * channel genuinely succeeded — a breaker-open skip or a thrown error leaves it untouched so the
 * next cycle retries the full check rather than considering it done.
 */
export function nextFullMediaCheckStamp(
	dueForFullCheck: boolean,
	succeeded: boolean,
	now: number,
	previous: number
): number {
	return dueForFullCheck && succeeded ? now : previous;
}
