export interface RetryOptions {
	/** Total attempts including the first (default 4). */
	maxAttempts?: number;
	/** First backoff step in ms (default 2000); doubles each retry. */
	baseMs?: number;
	/** Backoff ceiling in ms (default 60000). */
	maxMs?: number;
	/** Return false to fail fast without retrying (e.g. a 4xx). Default: always retry. */
	shouldRetry?: (err: unknown) => boolean;
	/** Override the wait before the next attempt — e.g. honor a `Retry-After` on a 429 instead of exponential backoff. */
	retryDelay?: (err: unknown, computedMs: number) => number;
}

/** 0-based attempt index: `baseMs · 2^n`, capped at `maxMs`. */
export function backoffDelay(
	attempt: number,
	opts: Pick<RetryOptions, 'baseMs' | 'maxMs'> = {}
): number {
	const { baseMs = 2000, maxMs = 60000 } = opts;
	return Math.min(baseMs * 2 ** attempt, maxMs);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(
	fn: () => Promise<T>,
	opts: RetryOptions = {},
	sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<T> {
	const { maxAttempts = 4, baseMs, maxMs, shouldRetry = () => true, retryDelay } = opts;
	let attempt = 0;
	for (;;) {
		try {
			return await fn();
		} catch (err) {
			attempt++;
			if (attempt >= maxAttempts || !shouldRetry(err)) throw err;
			const computed = backoffDelay(attempt - 1, { baseMs, maxMs });
			await sleep(retryDelay ? retryDelay(err, computed) : computed);
		}
	}
}

// Distinct from the raw `AbortError` so callers can tell a timeout from a caller-initiated abort — and retry only the former.
export class FetchTimeoutError extends Error {
	constructor(readonly timeoutMs: number) {
		super(`request timed out after ${timeoutMs}ms`);
		this.name = 'FetchTimeoutError';
	}
}

// A bare `fetch` has no timeout in workerd or the browser; a held-open stall wedges the sync engine's in-flight guard and silently stops all syncing.
export async function fetchWithTimeout(
	input: RequestInfo | URL,
	init: RequestInit & { timeoutMs: number },
	fetchFn: typeof fetch = fetch
): Promise<Response> {
	const { timeoutMs, signal, ...rest } = init;
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal?.addEventListener('abort', onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchFn(input, { ...rest, signal: controller.signal });
	} catch (err) {
		// Distinguish our deadline from a caller-initiated abort: only the former is a timeout.
		if (controller.signal.aborted && signal?.aborted !== true)
			throw new FetchTimeoutError(timeoutMs);
		throw err;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onAbort);
	}
}

export interface CircuitOptions {
	/** Consecutive failures that trip the breaker open (default 5). */
	maxFailures?: number;
	/** How long to stay open before allowing a half-open probe, ms (default 60000). */
	cooldownMs?: number;
	/** Clock source (injectable for tests). Default `Date.now`. */
	now?: () => number;
	name?: string;
}

type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
	#failures = 0;
	#openedAt = 0;
	#state: CircuitState = 'closed';
	readonly #maxFailures: number;
	readonly #cooldownMs: number;
	readonly #now: () => number;
	readonly #name: string | undefined;

	constructor(opts: CircuitOptions = {}) {
		this.#maxFailures = opts.maxFailures ?? 5;
		this.#cooldownMs = opts.cooldownMs ?? 60000;
		this.#now = opts.now ?? Date.now;
		this.#name = opts.name;
	}

	canAttempt(): boolean {
		if (this.#state === 'open') {
			if (this.#now() - this.#openedAt >= this.#cooldownMs) {
				this.#state = 'half-open';
				return true;
			}
			return false;
		}
		return true;
	}

	recordSuccess(): void {
		this.#failures = 0;
		this.#state = 'closed';
	}

	recordFailure(): void {
		this.#failures++;
		if (this.#failures >= this.#maxFailures && this.#state !== 'open') {
			this.#state = 'open';
			this.#openedAt = this.#now();
			console.warn(
				`circuit breaker${this.#name ? ` [${this.#name}]` : ''} opened after ${this.#failures} consecutive failures`
			);
		}
	}

	get state(): CircuitState {
		return this.#state;
	}

	get failures(): number {
		return this.#failures;
	}
}
