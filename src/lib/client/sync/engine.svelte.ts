/**
 * The client sync engine: a browser-only singleton that drives {@link runSync} on the
 * right triggers (app open/foreground, reconnect, a light interval, and a write-nudge),
 * coalesces overlapping requests, retries with backoff, and exposes a reactive
 * {@link SyncEngine.status} (plus {@link SyncEngine.lastError} detail) for a future
 * sync-pending indicator / error-reporting affordance (MRQ-95).
 *
 * Mirrors the `theme`/`pwa` rune singletons. Start it from the root layout when a user is
 * signed in; the store must already be scoped to that user (`setActiveUser`).
 */
import { backoffDelay, runSync, toSyncErrorInfo, type SyncErrorInfo } from './sync';

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

/** Coalesce bursts of trigger/nudge calls into one run this many ms later. */
const NUDGE_MS = 300;
/** Light polling cadence while the tab is open. */
const INTERVAL_MS = 45_000;

class SyncEngine {
	status = $state<SyncStatus>('idle');
	/** Detail of the most recent failure, retained for future error reporting; cleared on success. */
	lastError = $state<SyncErrorInfo | null>(null);
	/** Bumped each time a sync pulls+applies remote events, so open views can re-read local state. */
	revision = $state(0);

	#running = false;
	#rerun = false;
	#attempt = 0;
	#nudgeTimer: ReturnType<typeof setTimeout> | null = null;
	#retryTimer: ReturnType<typeof setTimeout> | null = null;
	#interval: ReturnType<typeof setInterval> | null = null;
	#teardown: Array<() => void> = [];
	#started = false;

	/** Wire triggers and kick an initial catch-up. Idempotent; browser-only. */
	start(): void {
		if (this.#started || typeof window === 'undefined') return;
		this.#started = true;

		const onVisible = () => {
			if (document.visibilityState === 'visible') this.requestSync();
		};
		const onOnline = () => this.requestSync();
		document.addEventListener('visibilitychange', onVisible);
		window.addEventListener('online', onOnline);
		window.addEventListener('focus', onOnline);
		this.#teardown.push(
			() => document.removeEventListener('visibilitychange', onVisible),
			() => window.removeEventListener('online', onOnline),
			() => window.removeEventListener('focus', onOnline)
		);

		this.#interval = setInterval(() => this.requestSync(), INTERVAL_MS);
		this.requestSync();
	}

	/** Remove triggers and cancel pending timers (call on logout / teardown). */
	stop(): void {
		this.#teardown.forEach((off) => off());
		this.#teardown = [];
		if (this.#nudgeTimer) clearTimeout(this.#nudgeTimer);
		if (this.#retryTimer) clearTimeout(this.#retryTimer);
		if (this.#interval) clearInterval(this.#interval);
		this.#nudgeTimer = this.#retryTimer = this.#interval = null;
		this.#started = false;
	}

	/** Ask for a sync soon. Debounced, so triggers/nudges in quick succession run once. */
	requestSync(): void {
		if (this.#nudgeTimer) return;
		this.#nudgeTimer = setTimeout(() => {
			this.#nudgeTimer = null;
			void this.#sync();
		}, NUDGE_MS);
	}

	async #sync(): Promise<void> {
		if (typeof navigator !== 'undefined' && !navigator.onLine) {
			this.status = 'offline';
			return;
		}
		if (this.#running) {
			this.#rerun = true; // fold this request into a follow-up pass
			return;
		}
		this.#running = true;
		this.status = 'syncing';
		if (this.#retryTimer) {
			clearTimeout(this.#retryTimer);
			this.#retryTimer = null;
		}
		try {
			const { pulled } = await runSync();
			if (pulled > 0) this.revision++; // let open views re-read the freshly-applied state
			this.#attempt = 0;
			this.lastError = null;
			this.status = 'idle';
		} catch (err) {
			this.status = 'error';
			this.lastError = toSyncErrorInfo(err, this.#attempt, Date.now());
			this.#retryTimer = setTimeout(() => {
				this.#retryTimer = null;
				void this.#sync();
			}, backoffDelay(this.#attempt++));
		} finally {
			this.#running = false;
			if (this.#rerun) {
				this.#rerun = false;
				this.requestSync();
			}
		}
	}
}

/** The app-wide sync engine. */
export const sync = new SyncEngine();
