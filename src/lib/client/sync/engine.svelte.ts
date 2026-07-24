/**
 * The client sync engine: a browser-only singleton that drives the sync channels on the right
 * triggers (app open/foreground, reconnect, a light interval, and a write-nudge), coalesces
 * overlapping requests, and exposes a reactive {@link SyncEngine.status} (plus
 * {@link SyncEngine.lastError} detail) for a future sync-pending / error-reporting UI (MRQ-95).
 *
 * Resilience: each channel (event, media) runs through {@link withRetry} for in-cycle backoff and
 * its own {@link CircuitBreaker} so a persistently-failing channel **stops** hammering rather than
 * retrying forever — it pauses until the cooldown lets a trigger probe it again. The shared
 * helpers live in `$lib/resilience` (also used by the server TMDB client).
 *
 * Mirrors the `theme`/`pwa` rune singletons. Start it from the root layout when a user is
 * signed in; the store must already be scoped to that user (`setActiveUser`).
 */
import { runSync, SyncError, toSyncErrorInfo, type SyncErrorInfo } from './sync';
import { runMediaSync } from './media-sync';
import { CircuitBreaker, withRetry, type RetryOptions } from '$lib/resilience';

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

/** Coalesce bursts of trigger/nudge calls into one run this many ms later. */
const NUDGE_MS = 300;
/** Light polling cadence while the tab is open — also the natural retry cadence after a failure. */
const INTERVAL_MS = 45_000;
/** Per-channel in-cycle retry (2s → 4s), so a transient blip self-heals within one cycle. */
const RETRY: RetryOptions = { maxAttempts: 3, baseMs: 2000, maxMs: 60000 };
/** Trip a channel's breaker after this many consecutive cycle failures, then pause for the cooldown. */
const CIRCUIT = { maxFailures: 3, cooldownMs: 60_000 };

/** Retry a `/api/sync` failure only when it's transient — network error, or 5xx/429, not a 4xx. */
const retriableSync = (err: unknown) =>
	!(err instanceof SyncError) || err.status >= 500 || err.status === 429;

class SyncEngine {
	status = $state<SyncStatus>('idle');
	/** Detail of the most recent event-sync failure, retained for future error reporting; cleared on success. */
	lastError = $state<SyncErrorInfo | null>(null);
	/** Bumped each time a sync pulls+applies remote data, so open views can re-read local state. */
	revision = $state(0);

	#running = false;
	#rerun = false;
	#nudgeTimer: ReturnType<typeof setTimeout> | null = null;
	#interval: ReturnType<typeof setInterval> | null = null;
	#teardown: Array<() => void> = [];
	#started = false;
	// Independent breakers so a failing media channel never stops event sync, and vice versa.
	#events = new CircuitBreaker(CIRCUIT);
	#media = new CircuitBreaker(CIRCUIT);

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
		if (this.#interval) clearInterval(this.#interval);
		this.#nudgeTimer = this.#interval = null;
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

	/**
	 * Run one channel through its breaker: `null` when the breaker is open (skipped this cycle),
	 * the resolved value on success; throws — after in-cycle retries — on failure (tripping it).
	 */
	async #runChannel<T>(
		circuit: CircuitBreaker,
		fn: () => Promise<T>,
		shouldRetry?: (err: unknown) => boolean
	): Promise<T | null> {
		if (!circuit.canAttempt()) return null;
		try {
			const value = await withRetry(fn, { ...RETRY, shouldRetry });
			circuit.recordSuccess();
			return value;
		} catch (err) {
			circuit.recordFailure();
			throw err;
		}
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
		try {
			let changed = false;

			// Event channel — authoritative; drives the visible status.
			try {
				const res = await this.#runChannel(this.#events, () => runSync(), retriableSync);
				if (res === null) {
					this.status = 'error'; // breaker open — keep the error state, skip the rest
					return;
				}
				this.lastError = null;
				if (res.pulled > 0) changed = true;
			} catch (err) {
				this.lastError = toSyncErrorInfo(err, this.#events.failures, Date.now());
				// Browser-visible; the server side is captured by the `handleError` hook → observability.
				console.error('[sync] event sync failed', this.lastError);
				this.status = 'error';
				return; // events are the base — don't run media on top of a failed event sync
			}

			// Media channel — best-effort (events are already synced). Backs off + stops on its own
			// breaker; a media failure never flips the visible status.
			try {
				const res = await this.#runChannel(this.#media, () => runMediaSync());
				if (res && res.applied > 0) changed = true;
			} catch (err) {
				console.warn('[sync] media sync failed (will retry later)', err);
			}

			if (changed) this.revision++;
			this.status = 'idle';
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
