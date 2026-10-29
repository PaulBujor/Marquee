/** Much slower than event sync on purpose: nothing sub-day can usefully chase a 12h TTL. */
export const FULL_MEDIA_CHECK_MS = 15 * 60 * 1000;

export function isFullMediaCheckDue(lastFullMediaCheck: number, now: number): boolean {
	return now - lastFullMediaCheck >= FULL_MEDIA_CHECK_MS;
}

export function shouldRunMediaSync(
	pulled: number,
	lastFullMediaCheck: number,
	now: number
): boolean {
	return pulled > 0 || isFullMediaCheckDue(lastFullMediaCheck, now);
}

/** Only advances on a genuine success, so a breaker-open skip retries the full check. */
export function nextFullMediaCheckStamp(
	dueForFullCheck: boolean,
	succeeded: boolean,
	now: number,
	previous: number
): number {
	return dueForFullCheck && succeeded ? now : previous;
}
