import { describe, expect, it, vi } from 'vitest';
import { backoffDelay, CircuitBreaker, withRetry } from './resilience';

describe('backoffDelay', () => {
	it('grows exponentially from base and caps at max', () => {
		expect(backoffDelay(0)).toBe(2000);
		expect(backoffDelay(1)).toBe(4000);
		expect(backoffDelay(2)).toBe(8000);
		expect(backoffDelay(20)).toBe(60000);
		expect(backoffDelay(0, { baseMs: 100, maxMs: 500 })).toBe(100);
		expect(backoffDelay(4, { baseMs: 100, maxMs: 500 })).toBe(500);
	});
});

describe('withRetry', () => {
	const noSleep = async () => {};

	it('returns on first success without sleeping', async () => {
		const fn = vi.fn(async () => 'ok');
		const sleep = vi.fn(noSleep);
		expect(await withRetry(fn, { maxAttempts: 3 }, sleep)).toBe('ok');
		expect(fn).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it('retries transient failures then succeeds', async () => {
		let n = 0;
		const fn = vi.fn(async () => {
			if (++n < 3) throw new Error('fail');
			return n;
		});
		const sleep = vi.fn(noSleep);
		expect(await withRetry(fn, { maxAttempts: 5 }, sleep)).toBe(3);
		expect(fn).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenCalledTimes(2);
	});

	it('throws the last error after maxAttempts', async () => {
		const fn = vi.fn(async () => {
			throw new Error('always');
		});
		const sleep = vi.fn(noSleep);
		await expect(withRetry(fn, { maxAttempts: 3 }, sleep)).rejects.toThrow('always');
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it('does not retry when shouldRetry returns false', async () => {
		const fn = vi.fn(async () => {
			throw new Error('4xx');
		});
		const sleep = vi.fn(noSleep);
		await expect(
			withRetry(fn, { maxAttempts: 5, shouldRetry: () => false }, sleep)
		).rejects.toThrow('4xx');
		expect(fn).toHaveBeenCalledTimes(1);
	});
});

describe('CircuitBreaker', () => {
	it('opens after maxFailures and blocks further attempts', () => {
		const cb = new CircuitBreaker({ maxFailures: 3, cooldownMs: 1000, now: () => 0 });
		expect(cb.canAttempt()).toBe(true);
		cb.recordFailure();
		cb.recordFailure();
		expect(cb.canAttempt()).toBe(true); // 2 failures — still closed
		cb.recordFailure(); // 3rd → open
		expect(cb.canAttempt()).toBe(false);
	});

	it('half-opens after cooldown and closes on success', () => {
		let t = 0;
		const cb = new CircuitBreaker({ maxFailures: 1, cooldownMs: 1000, now: () => t });
		cb.recordFailure(); // open at t=0
		expect(cb.canAttempt()).toBe(false);
		t = 1000;
		expect(cb.canAttempt()).toBe(true); // cooldown elapsed → half-open probe
		cb.recordSuccess();
		expect(cb.canAttempt()).toBe(true); // closed
	});

	it('re-opens if the half-open probe fails', () => {
		let t = 0;
		const cb = new CircuitBreaker({ maxFailures: 1, cooldownMs: 1000, now: () => t });
		cb.recordFailure(); // open at t=0
		t = 1000;
		expect(cb.canAttempt()).toBe(true); // half-open
		cb.recordFailure(); // probe failed → re-open at t=1000
		t = 1999;
		expect(cb.canAttempt()).toBe(false);
		t = 2000;
		expect(cb.canAttempt()).toBe(true);
	});
});
