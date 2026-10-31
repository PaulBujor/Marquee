import { isAbortError } from '#lib/abort.js';

/** Best-effort and silent — a reporter that throws would turn one error into two. */
export interface ClientErrorReport {
	message: string;
	/** Where it came from — a route id, `'sync'`, etc. */
	source?: string;
	status?: number;
	stack?: string;
	url?: string;
	/** Epoch ms. */
	at?: number;
	/** Set by a caller that has already told the user in its own words — no second toast. */
	handled?: boolean;
}

type ClientErrorListener = (report: ClientErrorReport) => void;
const listeners = new Set<ClientErrorListener>();

/** A throwing listener must never be able to lose the report the sink still has to send. */
export function onClientError(listener: ClientErrorListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function reportClientError(report: ClientErrorReport): void {
	for (const listener of listeners) {
		try {
			listener(report);
		} catch {
			// Never let a listener swallow the report the sink still needs to send.
		}
	}
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

/** A render loop can throw thousands of times a second; unbounded reporting would be thousands of POSTs. */
const MAX_REPORTS_PER_PAGE = 20;

export interface GlobalReportingOptions {
	/** Defaults to `window`; injectable so the wiring is testable off a plain EventTarget. */
	target?: EventTarget;
	report?: (report: ClientErrorReport) => void;
}

let installed = false;

/**
 * SvelteKit's `handleError` only sees navigation and render throws, so handler/timer/promise errors
 * reach the sink only through this net.
 */
export function installGlobalErrorReporting(options: GlobalReportingOptions = {}): () => void {
	const target = options.target ?? (typeof window === 'undefined' ? undefined : window);
	if (!target || installed) return () => {};
	installed = true;

	const report = options.report ?? reportClientError;
	/**
	 * Path only: reports land in durable Cloudflare logs, so a query string must never be sent.
	 */
	const safeUrl = () => (typeof location === 'undefined' ? undefined : location.pathname);
	const seen = new Set<string>();
	let sent = 0;

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
				url: safeUrl(),
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
		// A cross-origin script reports only this placeholder, with no error object: nothing to act on.
		if (!e.error && /^Script error\.?$/.test(e.message ?? '')) return;
		send(
			e.error instanceof Error ? e.error.message : (e.message ?? 'Unknown error'),
			e.error instanceof Error ? e.error.stack : undefined,
			'window.error'
		);
	};

	const onRejection = (event: Event) => {
		const reason = (event as PromiseRejectionEvent).reason;
		// Aborts mean navigation or backgrounding cancelled in-flight work, which is not a failure.
		if (isAbortError(reason)) return;
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
