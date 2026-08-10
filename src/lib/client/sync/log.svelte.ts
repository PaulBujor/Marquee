// Client-only sync log — a rune singleton, like theme/navigation/tabs.
//
// Exists to answer "what is sync doing right now", a hanging cycle in particular: each phase logs
// when it starts as well as when it finishes, so a stall shows up as a start with no end. Mirrored
// to sessionStorage so the log survives a reload as well as navigation.

import {
	appendEntry,
	parseEntries,
	type SyncLogChannel,
	type SyncLogEntry,
	type SyncLogLevel
} from './log';

const STORAGE_KEY = 'marquee:sync-log';
/** Coalesce the writes a burst of log lines would otherwise make. */
const PERSIST_DEBOUNCE_MS = 250;

class SyncLog {
	/** Newest first. */
	entries = $state<SyncLogEntry[]>([]);

	#persistTimer: ReturnType<typeof setTimeout> | null = null;
	#loaded = false;

	/** Restore the session's entries. Idempotent; browser-only. */
	load(): void {
		if (this.#loaded || typeof sessionStorage === 'undefined') return;
		this.#loaded = true;
		try {
			this.entries = parseEntries(sessionStorage.getItem(STORAGE_KEY));
		} catch {
			this.entries = [];
		}
	}

	add(channel: SyncLogChannel, message: string, level: SyncLogLevel = 'info'): void {
		this.entries = appendEntry(this.entries, { at: Date.now(), channel, message, level });
		this.#persist();
	}

	clear(): void {
		this.entries = [];
		try {
			sessionStorage?.removeItem(STORAGE_KEY);
		} catch {
			/* storage disabled or full — the in-memory log is the source of truth */
		}
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

export const syncLog = new SyncLog();
