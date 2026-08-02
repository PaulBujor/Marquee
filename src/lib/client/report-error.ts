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

/**
 * Most reports come from a `catch` that knew to call {@link reportClientError}. These two caps are
 * for the ones that don't: a render loop or a retrying timer can throw the same error thousands of
 * times a second, and an unbounded reporter would turn that into thousands of POSTs.
 */
const MAX_REPORTS_PER_PAGE = 20;

export interface GlobalReportingOptions {
	/** Defaults to `window`; injectable so the wiring is testable off a plain EventTarget. */
	target?: EventTarget;
	report?: (report: ClientErrorReport) => void;
}

let installed = false;

/**
 * The catch-all net: report errors that escape everything else. SvelteKit's `handleError` only
 * sees throws during navigation and rendering, so anything from an event handler, a timer or a
 * floating promise never reaches the sink otherwise.
 *
 * It doesn't replace explicit reporting — an error a `catch` handles never becomes uncaught.
 * Returns a teardown function; calling it twice installs one set of listeners.
 */
export function installGlobalErrorReporting(options: GlobalReportingOptions = {}): () => void {
	const target = options.target ?? (typeof window === 'undefined' ? undefined : window);
	if (!target || installed) return () => {};
	installed = true;

	const report = options.report ?? reportClientError;
	const seen = new Set<string>();
	let sent = 0;

	/** Report unless we've already sent this exact error, or hit the per-page cap. */
	const send = (message: string, stack: string | undefined, source: string) => {
		try {
			const key = `${source}:${message}`;
			if (seen.has(key) || sent >= MAX_REPORTS_PER_PAGE) return;
			seen.add(key);
			sent += 1;
			report({
				message,
				stack,
				source,
				url: typeof location === 'undefined' ? undefined : location.href,
				at: Date.now()
			});
		} catch {
			// A reporter that throws would defeat the point of a catch-all.
		}
	};

	const onError = (event: Event) => {
		const e = event as ErrorEvent;
		// A failed <img>/<script> load also fires 'error' here, with neither field set. Those aren't
		// exceptions and there's nothing useful to log.
		if (!e.error && !e.message) return;
		send(
			e.error instanceof Error ? e.error.message : (e.message ?? 'Unknown error'),
			e.error instanceof Error ? e.error.stack : undefined,
			'window.error'
		);
	};

	const onRejection = (event: Event) => {
		const reason = (event as PromiseRejectionEvent).reason;
		send(
			reason instanceof Error ? reason.message : String(reason),
			reason instanceof Error ? reason.stack : undefined,
			'unhandledrejection'
		);
	};

	target.addEventListener('error', onError);
	target.addEventListener('unhandledrejection', onRejection);

	return () => {
		target.removeEventListener('error', onError);
		target.removeEventListener('unhandledrejection', onRejection);
		installed = false;
	};
}
