// Client error log — a rune singleton, like theme/navigation/sync-log. Mirrored to sessionStorage
// so an error survives the reload it may well have caused, and dies with the tab.

import { appendError, parseErrors, type ClientErrorEntry } from './errors';
import { onClientError, type ClientErrorReport } from './report-error';

const STORAGE_KEY = 'marquee:errors';
/** Coalesce the writes a burst of errors would otherwise make. */
const PERSIST_DEBOUNCE_MS = 250;

class ErrorLog {
	/** Newest first. */
	entries = $state<ClientErrorEntry[]>([]);
	/** The latest error nobody has told the user about yet. Cleared by whoever surfaces it. */
	pending = $state<ClientErrorEntry | null>(null);

	#persistTimer: ReturnType<typeof setTimeout> | null = null;
	#started = false;

	/**
	 * Load the persisted log and start recording. Idempotent, browser-only, and never torn down —
	 * it runs for the life of the page, from `hooks.client.ts` so it catches errors thrown before
	 * any component mounts.
	 *
	 * Persisted errors are deliberately not replayed as `pending`: after a reload the user has
	 * already lived through whatever happened, and a toast for it would be noise.
	 */
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
		this.entries = [];
		this.pending = null;
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
		// A caller that already explained the failure keeps its own message — but the error is still
		// logged, because "the user saw something friendly" isn't "we know what happened".
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
