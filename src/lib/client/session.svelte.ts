/**
 * Session-expiry state — a rune singleton, mirroring the pattern of `errors.svelte.ts`. The sync
 * engine calls `expire()` on the first 401 and subsequent channels fold into the same announcement
 * (idempotent). The root layout reads `expired` to stop the engine, and the toast component reads
 * `announced` to know when to fire.
 *
 * The pure detection helpers live in `./session.ts` (no runes, no state, testable in isolation);
 * this module layers the reactive state on top.
 */
import { reportClientError } from './report-error';
import type { SessionExpiredError } from './session';

class SessionState {
	/** Whether a session expiry has been detected in this page life. */
	expired = $state(false);
	/**
	 * Whether the toast has already been raised for this expiry — set by the toast component, never
	 * by the engine, so a single expiry doesn't pile up toasts regardless of how many channels 401.
	 */
	announced = $state(false);

	/**
	 * Mark the session as expired. **Idempotent** — the first call flips `expired` and reports to the
	 * diagnostics sink with `handled: true`; subsequent calls are no-ops. Called by the sync engine
	 * when any channel catches a {@link SessionExpiredError}.
	 */
	expire(source: string): void {
		if (this.expired) return;
		this.expired = true;
		reportClientError({
			message: `Session expired (${source})`,
			source: 'session-expiry',
			handled: true,
			at: Date.now()
		});
	}

	/**
	 * Reset on a fresh sign-in: clear expired/announced so the next session expiry can be detected
	 * (the old one is gone — the user signed in again). Called from the login page on verify success
	 * and from the root layout's account-change effect.
	 */
	reset(): void {
		this.expired = false;
		this.announced = false;
	}

	/**
	 * Convenience: check whether a response is an auth failure and, if so, mark the session expired
	 * and return `true`. For loads and components that degrade rather than abort — they keep their
	 * existing fallback shape; the persistent toast and indicator carry the explanation.
	 *
	 * @returns `true` when `res.status` is an auth failure and the session was just marked expired.
	 */
	authFailed(res: Response, source: string): boolean {
		if (res.status !== 401) return false;
		this.expire(source);
		return true;
	}
}

export const session = new SessionState();