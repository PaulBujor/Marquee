/** Distinct from `SyncError` so the engine ends the session: no retry, no circuit-breaker trip. */
export class SessionExpiredError extends Error {
	/** Where the 401 came from — `'sync'`, `'media-sync'`, `'image-sync'`, etc. */
	constructor(readonly source: string) {
		super(`session expired: HTTP 401 from ${source}`);
		this.name = 'SessionExpiredError';
	}
}

export function isAuthFailure(status: number): boolean {
	return status === 401;
}

/** Callers test any other status themselves for their own error types. */
export function assertAuthed(res: Response, source: string): void {
	if (isAuthFailure(res.status)) throw new SessionExpiredError(source);
}
