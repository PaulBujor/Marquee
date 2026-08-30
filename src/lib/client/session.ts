/**
 * Session-expiry detection — pure, rune-free, unit-testable helpers for the sync channels and
 * client-side authed fetches. Every caller that may receive a 401 uses one of these to produce a
 * {@link SessionExpiredError}, which the engine catches and turns into the signed-out UX.
 *
 * @module session
 */

/**
 * Thrown when an authed request returns 401. Distinct from {@link SyncError} so the engine treats
 * it as an end-of-session, not a transient blip: no retry, no circuit-breaker trip, no generic
 * error toast.
 */
export class SessionExpiredError extends Error {
	/** @param source Where the 401 came from — `'sync'`, `'media-sync'`, `'image-sync'`, etc. */
	constructor(readonly source: string) {
		super(`session expired: HTTP 401 from ${source}`);
		this.name = 'SessionExpiredError';
	}
}

/** `true` when the status code represents an auth failure — currently only 401. */
export function isAuthFailure(status: number): boolean {
	return status === 401;
}

/**
 * Throw {@link SessionExpiredError} when `res` has an auth-failure status, so callers that already
 * have the response in hand can abort cleanly. No-op for any other status — callers test that
 * themselves for their own error types. `source` identifies the channel for diagnostics.
 */
export function assertAuthed(res: Response, source: string): void {
	if (isAuthFailure(res.status)) throw new SessionExpiredError(source);
}