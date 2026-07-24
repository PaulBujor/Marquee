/**
 * Generic, dependency-free resilience helpers for outgoing requests — a small "pipeline" shared
 * by the client sync channels (event/media/image) and the server TMDB client. Pure and
 * runtime-agnostic (browser + Workers); time and sleep are injectable so it's fully testable.
 */

/** Options for {@link backoffDelay} / {@link withRetry}. */
export interface RetryOptions {
	/** Total attempts including the first (default 4). */
	maxAttempts?: number;
	/** First backoff step in ms (default 2000); doubles each retry. */
	baseMs?: number;
	/** Backoff ceiling in ms (default 60000). */
	maxMs?: number;
	/** Return false to fail fast without retrying (e.g. a 4xx). Default: always retry. */
	shouldRetry?: (err: unknown) => boolean;
}

/** Exponential backoff (ms) for a 0-based attempt index: `baseMs · 2^n`, capped at `maxMs`. */
export function backoffDelay(
	attempt: number,
	opts: Pick<RetryOptions, 'baseMs' | 'maxMs'> = {}
): number {
	const { baseMs = 2000, maxMs = 60000 } = opts;
	return Math.min(baseMs * 2 ** attempt, maxMs);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying transient failures with exponential backoff; throws the last error once
 * `maxAttempts` is reached or `shouldRetry` returns false. `sleep` is injectable for tests.
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	opts: RetryOptions = {},
	sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<T> {
	const { maxAttempts = 4, baseMs, maxMs, shouldRetry = () => true } = opts;
	let attempt = 0;
	for (;;) {
		try {
			return await fn();
		} catch (err) {
			attempt++;
			if (attempt >= maxAttempts || !shouldRetry(err)) throw err;
			await sleep(backoffDelay(attempt - 1, { baseMs, maxMs }));
		}
	}
}

/** Options for {@link CircuitBreaker}. */
export interface CircuitOptions {
	/** Consecutive failures that trip the breaker open (default 5). */
	maxFailures?: number;
	/** How long to stay open before allowing a half-open probe, ms (default 60000). */
	cooldownMs?: number;
	/** Clock source (injectable for tests). Default `Date.now`. */
	now?: () => number;
}

type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * A minimal circuit breaker: after `maxFailures` consecutive failures it **opens** and
 * {@link canAttempt} returns false (fail fast) until `cooldownMs` elapses, then it **half-opens**
 * to allow one probe — a success closes it, another failure re-opens it. Stops a sustained
 * outage (e.g. a persistently-failing sync channel or TMDB) from being hammered every cycle.
 */
export class CircuitBreaker {
	#failures = 0;
	#openedAt = 0;
	#state: CircuitState = 'closed';
	readonly #maxFailures: number;
	readonly #cooldownMs: number;
	readonly #now: () => number;

	constructor(opts: CircuitOptions = {}) {
		this.#maxFailures = opts.maxFailures ?? 5;
		this.#cooldownMs = opts.cooldownMs ?? 60000;
		this.#now = opts.now ?? Date.now;
	}

	/** Whether a call is allowed now. Transitions open → half-open once the cooldown has elapsed. */
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

	/** Record a success: reset the failure count and close the breaker. */
	recordSuccess(): void {
		this.#failures = 0;
		this.#state = 'closed';
	}

	/** Record a failure: trip open once the threshold is reached (or re-open from half-open). */
	recordFailure(): void {
		this.#failures++;
		if (this.#failures >= this.#maxFailures) {
			this.#state = 'open';
			this.#openedAt = this.#now();
		}
	}

	get state(): CircuitState {
		return this.#state;
	}

	/** Consecutive failures since the last success (0 when closed after a success). */
	get failures(): number {
		return this.#failures;
	}
}
