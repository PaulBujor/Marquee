/**
 * Client-side error sink: forward browser errors to `/api/client-error`, which logs them
 * to Cloudflare observability. Best-effort and **silent** — a reporter must never throw or surface a
 * failure of its own (that would turn one error into two). Used by the `handleError` client hook and
 * by the sync engine when a channel fails.
 */
export interface ClientErrorReport {
	message: string;
	/** Where it came from — a route id, `'sync'`, etc. */
	source?: string;
	/** HTTP status, when the error was a bad response (e.g. a sync 5xx). */
	status?: number;
	stack?: string;
	url?: string;
	/** Epoch ms the error occurred. */
	at?: number;
}

/** Fire-and-forget POST the report; swallow every failure. No-op outside the browser. */
export function reportClientError(report: ClientErrorReport): void {
	if (typeof fetch === 'undefined') return;
	try {
		void fetch('/api/client-error', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(report),
			keepalive: true // let it complete even if the page is unloading
		}).catch(() => {});
	} catch {
		// Reporting must never cascade into another error.
	}
}
