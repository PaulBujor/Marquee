import { appendError, parseErrors, type ClientErrorEntry } from './errors';
import { onClientError, type ClientErrorReport } from './report-error';

const STORAGE_KEY = 'marquee:errors';
const PERSIST_DEBOUNCE_MS = 250;

class ErrorLog {
	/** Newest first. */
	entries = $state<ClientErrorEntry[]>([]);
	/** Cleared by whoever surfaces it. */
	pending = $state<ClientErrorEntry | null>(null);
	suppressedCount = $state(0);

	#persistTimer: ReturnType<typeof setTimeout> | null = null;
	#started = false;

	/** Persisted errors are deliberately not replayed as `pending`: after a reload a toast is noise. */
	start(): void {
		if (this.#started || typeof window === 'undefined') return;
		this.#started = true;
		try {
			this.entries = parseErrors(sessionStorage.getItem(STORAGE_KEY));
		} catch {
			this.entries = [];
		}
		onClientError((report) => this.#record(report));
	}

	clear(): void {
		if (this.#persistTimer) {
			clearTimeout(this.#persistTimer);
			this.#persistTimer = null;
		}
		this.entries = [];
		this.pending = null;
		this.suppressedCount = 0;
		try {
			sessionStorage?.removeItem(STORAGE_KEY);
		} catch {
			/* storage disabled or full — the in-memory log is the source of truth */
		}
	}

	#record(report: ClientErrorReport): void {
		this.entries = appendError(this.entries, {
			at: report.at ?? Date.now(),
			message: report.message,
			source: report.source,
			stack: report.stack,
			url: report.url,
			status: report.status,
			count: 1
		});
		// A caller that already explained the failure keeps its own message; the error is still logged.
		if (!report.handled) this.pending = this.entries[0];
		this.#persist();
	}

	#persist(): void {
		if (typeof sessionStorage === 'undefined') return;
		if (this.#persistTimer) clearTimeout(this.#persistTimer);
		this.#persistTimer = setTimeout(() => {
			this.#persistTimer = null;
			try {
				sessionStorage.setItem(STORAGE_KEY, JSON.stringify($state.snapshot(this.entries)));
			} catch {
				/* storage disabled or full — the in-memory log is the source of truth */
			}
		}, PERSIST_DEBOUNCE_MS);
	}
}

export const errorLog = new ErrorLog();
