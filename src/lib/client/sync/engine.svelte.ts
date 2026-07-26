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
import { runImageSync } from './image-sync';
import { CircuitBreaker, withRetry, type RetryOptions } from '$lib/resilience';
import { getLastSyncAt, setLastSyncAt } from '$lib/client/idb';
import { reportClientError } from '$lib/client/report-error';

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

/**
 * On a 429 with a `Retry-After`, wait exactly that long instead of exponential backoff — honor the
 * server's clock rather than escalating (which a 429 makes wrong). Any other failure keeps normal
 * backoff. The engine's `maxAttempts` still bounds how many times a single cycle waits.
 */
const syncRetryDelay = (err: unknown, computedMs: number): number =>
	err instanceof SyncError && err.retryAfterMs != null ? err.retryAfterMs : computedMs;

class SyncEngine {
	status = $state<SyncStatus>('idle');
	/** Whether the browser currently reports a network connection — drives the offline indicator (MRQ-95). */
	online = $state(true);
	/** Detail of the most recent event-sync failure, retained for future error reporting; cleared on success. */
	lastError = $state<SyncErrorInfo | null>(null);
	/** Bumped each time a sync pulls+applies remote data, so open views can re-read local state. */
	revision = $state(0);
	/** Epoch ms of the last successful event sync (persisted), or null — shown in settings. */
	lastSyncAt = $state<number | null>(null);

	#running = false;
	#rerun = false;
	#nudgeTimer: ReturnType<typeof setTimeout> | null = null;
	#interval: ReturnType<typeof setInterval> | null = null;
	#teardown: Array<() => void> = [];
	#started = false;
	// Independent breakers so a failing channel never stops the others.
	#events = new CircuitBreaker({ ...CIRCUIT, name: 'sync:events' });
	#media = new CircuitBreaker({ ...CIRCUIT, name: 'sync:media' });
	#images = new CircuitBreaker({ ...CIRCUIT, name: 'sync:images' });

	/** Wire triggers and kick an initial catch-up. Idempotent; browser-only. */
	start(): void {
		if (this.#started || typeof window === 'undefined') return;
		this.#started = true;

		this.online = navigator.onLine;
		void getLastSyncAt().then((at) => (this.lastSyncAt = at));
		const onVisible = () => {
			if (document.visibilityState === 'visible') this.requestSync();
		};
		const onOnline = () => {
			this.online = true;
			this.requestSync();
		};
		const onOffline = () => {
			this.online = false;
			this.status = 'offline';
		};
		const onFocus = () => this.requestSync();
		document.addEventListener('visibilitychange', onVisible);
		window.addEventListener('online', onOnline);
		window.addEventListener('offline', onOffline);
		window.addEventListener('focus', onFocus);
		this.#teardown.push(
			() => document.removeEventListener('visibilitychange', onVisible),
			() => window.removeEventListener('online', onOnline),
			() => window.removeEventListener('offline', onOffline),
			() => window.removeEventListener('focus', onFocus)
		);

		// The service worker's Background Sync handler wakes us to sync when connectivity returns.
		if ('serviceWorker' in navigator) {
			const onSwMessage = (e: MessageEvent) => {
				if (e.data?.type === 'SYNC') this.requestSync();
			};
			navigator.serviceWorker.addEventListener('message', onSwMessage);
			this.#teardown.push(() =>
				navigator.serviceWorker.removeEventListener('message', onSwMessage)
			);
		}

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
		retry?: Pick<RetryOptions, 'shouldRetry' | 'retryDelay'>
	): Promise<T | null> {
		if (!circuit.canAttempt()) return null;
		try {
			const value = await withRetry(fn, { ...RETRY, ...retry });
			circuit.recordSuccess();
			return value;
		} catch (err) {
			circuit.recordFailure();
			throw err;
		}
	}

	/**
	 * Ask the service worker to flush our outbox when connectivity returns — even if the tab is later
	 * closed (Chromium/Android Background Sync). Best-effort and idempotent (same tag coalesces);
	 * unsupported browsers (iOS/Firefox) just reject, and the online/foreground triggers cover them.
	 */
	#registerBackgroundSync(): void {
		if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
		navigator.serviceWorker.ready
			.then((reg) => {
				const withSync = reg as ServiceWorkerRegistration & {
					sync?: { register(tag: string): Promise<void> };
				};
				return withSync.sync?.register('marquee-sync');
			})
			.catch(() => {});
	}

	async #sync(): Promise<void> {
		if (typeof navigator !== 'undefined' && !navigator.onLine) {
			this.online = false;
			this.status = 'offline';
			this.#registerBackgroundSync(); // flush on reconnect, even if the tab closes first
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
				const res = await this.#runChannel(this.#events, () => runSync(), {
					shouldRetry: retriableSync,
					retryDelay: syncRetryDelay
				});
				if (res === null) {
					this.status = 'error'; // breaker open — keep the error state, skip the rest
					return;
				}
				this.lastError = null;
				const syncedAt = Date.now();
				this.lastSyncAt = syncedAt;
				void setLastSyncAt(syncedAt);
				if (res.pulled > 0) changed = true;
			} catch (err) {
				this.lastError = toSyncErrorInfo(err, this.#events.failures, Date.now());
				// Browser-visible; also forward to the observability sink — client-side
				// failures never reach the server `handleError` hook on their own.
				console.error('[sync] event sync failed', this.lastError);
				reportClientError({
					message: this.lastError.message,
					status: this.lastError.status,
					source: 'sync',
					at: this.lastError.at
				});
				this.status = 'error';
				return; // events are the base — don't run media/images on top of a failed event sync
			}

			// Media channel — also surfaces in the sync indicator (a failing media sync, e.g. a large
			// library, should be visible, not silent). Same shape as the event channel: a breaker-open
			// skip or a throw flips the status to error and skips images for this cycle.
			try {
				const res = await this.#runChannel(this.#media, () => runMediaSync());
				if (res === null) {
					this.status = 'error';
					return;
				}
				if (res.applied > 0) changed = true;
			} catch (err) {
				this.lastError = toSyncErrorInfo(err, this.#media.failures, Date.now());
				console.error('[sync] media sync failed', this.lastError);
				reportClientError({
					message: this.lastError.message,
					status: this.lastError.status,
					source: 'media-sync',
					at: this.lastError.at
				});
				this.status = 'error';
				return;
			}

			// Image channel — best-effort (blobs for already-known media); never flips the status.
			try {
				const res = await this.#runChannel(this.#images, () => runImageSync());
				if (res && res.stored > 0) changed = true;
			} catch (err) {
				console.warn('[sync] image sync failed (will retry later)', err);
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
