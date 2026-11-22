import { reportClientError } from './report-error';

class SessionState {
	expired = $state(false);
	/** Set by the toast component, never by the engine, so a single expiry doesn't pile up toasts. */
	announced = $state(false);

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

	reset(): void {
		this.expired = false;
		this.announced = false;
	}

	/** For loads/components that degrade rather than abort; the toast carries the explanation. */
	authFailed(res: Response, source: string): boolean {
		if (res.status !== 401) return false;
		this.expire(source);
		return true;
	}
}

export const session = new SessionState();
