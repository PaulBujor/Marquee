/**
 * Client sync engine: drives event + media channels on triggers (open/foreground/reconnect/interval),
 * coalesces overlapping requests, exposes a reactive status. Each channel has retry + circuit breaker.
 */
import { runSync, SyncError, toSyncErrorInfo, type SyncErrorInfo } from './sync';
import { runMediaSync } from './media-sync';
import { runImageSync } from './image-sync';
import { isFullMediaCheckDue, nextFullMediaCheckStamp, shouldRunMediaSync } from './media-gate';
import { SessionExpiredError } from '$lib/client/session';
import { session } from '$lib/client/session.svelte';
import { CircuitBreaker, withRetry, type RetryOptions } from '$lib/resilience';
import { syncLog } from './log.svelte';
import {
	getLastSyncAt,
	setLastSyncAt,
	getLastFullMediaCheck,
	setLastFullMediaCheck,
	getReferencedMediaIds,
	pruneStaleMedia
} from '$lib/client/idb';
import { pruneMediaImages } from '$lib/client/idb/images';
import { reportClientError } from '$lib/client/report-error';

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline' | 'signed-out';

/** Coalesce bursts of trigger/nudge calls into one run this many ms later. */
const NUDGE_MS = 300;
/** Light polling cadence while the tab is open — also the natural retry cadence after a failure. */
const INTERVAL_MS = 60_000;
/** Per-channel in-cycle retry (2s → 4s), so a transient blip self-heals within one cycle. */
const RETRY: RetryOptions = { maxAttempts: 3, baseMs: 2000, maxMs: 60000 };
/** Trip a channel's breaker after this many consecutive cycle failures, then pause for the cooldown. */
const CIRCUIT = { maxFailures: 3, cooldownMs: 60_000 };

/** Retry a `/api/sync` failure only when it's transient — network error, or 5xx/429, not a 4xx. */
const retriableSync = (err: unknown) =>
	!(err instanceof SyncError) ||
	(err.status >= 500 || err.status === 429);

/**
 * On a 429 with a `Retry-After`, wait exactly that long instead of exponential backoff — honor the
 * server's clock rather than escalating (which a 429 makes wrong). Any other failure keeps normal
 * backoff. The engine's `maxAttempts` still bounds how many times a single cycle waits.
 */
const syncRetryDelay = (err: unknown, computedMs: number): number =>
	err instanceof SyncError && err.retryAfterMs != null ? err.retryAfterMs : computedMs;

class SyncEngine {
	status = $state<SyncStatus>('idle');
	/** Whether the browser currently reports a network connection — drives the offline indicator. */
	online = $state(true);
	/** Detail of the most recent event-sync failure, retained for future error reporting; cleared on success. */
	lastError = $state<SyncErrorInfo | null>(null);
	/** Bumped each time a sync pulls+applies remote data, so open views can re-read local state. */
	revision = $state(0);
	/** Epoch ms of the last successful event sync (persisted), or null — shown in settings. */
	lastSyncAt = $state<number | null>(null);
	/** Epoch ms the in-flight cycle began, or null when idle — lets the log show a stall's duration. */
	cycleStartedAt = $state<number | null>(null);

	#running = false;
	#rerun = false;
	#nudgeTimer: ReturnType<typeof setTimeout> | null = null;
	#interval: ReturnType<typeof setInterval> | null = null;
	#teardown: Array<() => void> = [];
	#started = false;
	/** Epoch ms of the last full media version-diff pass; 0 forces one on the first cycle. */
	#lastFullMediaCheck = 0;
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

		// Load the persisted full-check watermark before the first cycle can run, so a relaunch
		// resumes the cadence instead of restarting it at 0 (see media-gate.ts). The `#started`
		// guard drops this if `stop()` ran before the (local, near-instant) read resolved.
		void getLastFullMediaCheck().then((at) => {
			if (!this.#started) return;
			this.#lastFullMediaCheck = at;
			this.#interval = setInterval(() => this.requestSync(), INTERVAL_MS);
			this.requestSync();
		});
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
	 * Permanently stop syncing and mark the status as signed-out. Called by the root layout when
	 * `session.expired` flips. Killing the 60s interval is what ends the storm of 401 retries.
	 */
	markSignedOut(): void {
		this.stop();
		this.status = 'signed-out';
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
			// An expiry is not a channel fault — rethrow before tripping the breaker so a catch-up sync
			// right after the user signs back in isn't blocked by a 60s cooldown.
			if (err instanceof SessionExpiredError) throw err;
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
		if (session.expired) {
			this.status = 'signed-out';
			syncLog.add('cycle', 'signed out — sync paused', 'warn');
			return;
		}
		if (typeof navigator !== 'undefined' && !navigator.onLine) {
			this.online = false;
			this.status = 'offline';
			syncLog.add('cycle', 'offline — deferred until reconnect', 'warn');
			this.#registerBackgroundSync(); // flush on reconnect, even if the tab closes first
			return;
		}
		if (this.#running) {
			this.#rerun = true; // fold this request into a follow-up pass
			syncLog.add('cycle', 'already running — folded into a follow-up pass');
			return;
		}
		this.#running = true;
		this.status = 'syncing';
		const cycleStart = Date.now();
		this.cycleStartedAt = cycleStart;
		syncLog.add('cycle', 'started');
		try {
			let changed = false;
			let pulled = 0; // events pulled this cycle — the sequence-watermark signal for the media gate below
			let pushed = 0; // events pushed this cycle — with `pulled`, gates the cache sweep below

			// Event channel — authoritative; drives the visible status.
			try {
				syncLog.add('events', 'push + pull…');
				const startedAt = Date.now();
				const res = await this.#runChannel(this.#events, () => runSync(), {
					shouldRetry: retriableSync,
					retryDelay: syncRetryDelay
				});
				if (res === null) {
					this.status = 'error'; // breaker open — keep the error state, skip the rest
					syncLog.add('events', 'skipped — circuit open after repeated failures', 'error');
					return;
				}
				syncLog.add(
					'events',
					`pushed ${res.pushed}, pulled ${res.pulled} in ${Date.now() - startedAt}ms`
				);
				this.lastError = null;
				const syncedAt = Date.now();
				this.lastSyncAt = syncedAt;
				void setLastSyncAt(syncedAt);
				pulled = res.pulled;
				pushed = res.pushed;
				if (pulled > 0) changed = true;
			} catch (err) {
				if (err instanceof SessionExpiredError) {
					session.expire('sync');
					syncLog.add('events', 'session expired — sync paused', 'warn');
					this.status = 'signed-out';
					return;
				}
				this.lastError = toSyncErrorInfo(err, this.#events.failures, Date.now());
				syncLog.add('events', `failed — ${this.lastError.message}`, 'error');
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

			// Media channel — gated on the event channel's watermark; see `media-gate.ts` for why.
			const cycleNow = Date.now();
			const dueForFullCheck = isFullMediaCheckDue(this.#lastFullMediaCheck, cycleNow);
			const runMedia = shouldRunMediaSync(pulled, this.#lastFullMediaCheck, cycleNow);
			if (!runMedia) syncLog.add('media', 'skipped — nothing new to ask about');
			if (runMedia) {
				// Also surfaces in the sync indicator (a failing media sync, e.g. a large library,
				// should be visible, not silent). Same shape as the event channel: a breaker-open
				// skip or a throw flips the status to error and skips images for this cycle.
				try {
					syncLog.add('media', `${dueForFullCheck ? 'full version-diff' : 'light'} pass…`);
					const startedAt = Date.now();
					const mediaRes = await this.#runChannel(this.#media, () =>
						runMediaSync({ fullCheck: dueForFullCheck })
					);
					if (mediaRes === null) {
						this.status = 'error';
						syncLog.add('media', 'skipped — circuit open after repeated failures', 'error');
						return;
					}
					syncLog.add(
						'media',
						`applied ${mediaRes.applied}${mediaRes.pushed > 0 ? `, backed up ${mediaRes.pushed}` : ''} in ${Date.now() - startedAt}ms`
					);
					const nextCheck = nextFullMediaCheckStamp(
						dueForFullCheck,
						true,
						Date.now(),
						this.#lastFullMediaCheck
					);
					if (nextCheck !== this.#lastFullMediaCheck) {
						this.#lastFullMediaCheck = nextCheck;
						void setLastFullMediaCheck(nextCheck);
					}
					if (mediaRes.applied > 0 || mediaRes.pushed > 0) changed = true;
				} catch (err) {
					if (err instanceof SessionExpiredError) {
						session.expire('media-sync');
						syncLog.add('media', 'session expired — sync paused', 'warn');
						this.status = 'signed-out';
						return;
					}
					this.lastError = toSyncErrorInfo(err, this.#media.failures, Date.now());
					syncLog.add('media', `failed — ${this.lastError.message}`, 'error');
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
			}

			// Image channel — best-effort (blobs for already-known media); never flips the status.
			try {
				syncLog.add('images', 'caching posters…');
				const startedAt = Date.now();
				const res = await this.#runChannel(this.#images, () => runImageSync());
				if (res && res.stored > 0) changed = true;
				syncLog.add('images', `stored ${res?.stored ?? 0} in ${Date.now() - startedAt}ms`);
			} catch (err) {
				if (err instanceof SessionExpiredError) {
					session.expire('image-sync');
					syncLog.add('images', 'session expired — sync paused', 'warn');
					return;
				}
				syncLog.add('images', `failed — ${String(err)}`, 'warn');
				console.warn('[sync] image sync failed (will retry later)', err);
			}

			// Drop cached media + images for titles that left every list. Local-only, and gated on the
			// cycle having moved events — a removal is either pushed from here or pulled from another
			// device, so an idle tab never rescans the stores.
			if (pushed > 0 || pulled > 0) {
				try {
					const keepIds = new Set(await getReferencedMediaIds());
					await pruneStaleMedia(keepIds);
					await pruneMediaImages(keepIds);
					syncLog.add('cache', `swept, keeping ${keepIds.size} titles`);
				} catch (err) {
					syncLog.add('cache', `sweep failed — ${String(err)}`, 'warn');
					console.warn('[sync] cache sweep failed (will retry next cycle)', err);
				}
			}

			if (changed) this.revision++;
			this.status = 'idle';
		} finally {
			syncLog.add('cycle', `finished (${this.status}) in ${Date.now() - cycleStart}ms`);
			this.cycleStartedAt = null;
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
