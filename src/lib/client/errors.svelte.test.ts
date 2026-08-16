import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorLog } from './errors.svelte';
import { onClientError, reportClientError } from './report-error';

// `start()` bails when `typeof window === 'undefined'` — provide a minimal browser-like global
// so the listener registers and sessionStorage works.
const storage = new Map<string, string>();
const fakeWindow = {} as typeof globalThis;
const fakeSessionStorage = {
	getItem: (k: string) => storage.get(k) ?? null,
	setItem: (k: string, v: string) => void storage.set(k, v),
	removeItem: (k: string) => void storage.delete(k)
};

beforeEach(() => {
	storage.clear();
	vi.stubGlobal('window', fakeWindow);
	vi.stubGlobal('sessionStorage', fakeSessionStorage);
});

afterEach(() => {
	errorLog.clear();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('ErrorLog', () => {
	// This test must run before start() is called in other tests, because the singleton's
	// #started flag persists — a second start() is a no-op.
	it('start() loads persisted entries from sessionStorage', () => {
		const stored = JSON.stringify([{ at: 100, message: 'old error', count: 1 }]);
		storage.set('marquee:errors', stored);

		errorLog.start();
		expect(errorLog.entries).toHaveLength(1);
		expect(errorLog.entries[0].message).toBe('old error');
	});

	it('clear() cancels a pending debounced persist', async () => {
		vi.useFakeTimers();
		errorLog.start();

		reportClientError({ message: 'boom', source: 'clear-test' });
		expect(errorLog.entries).toHaveLength(1);

		errorLog.clear();
		expect(errorLog.entries).toHaveLength(0);

		// Advance past the debounce — the old persist must not reappear.
		await vi.advanceTimersByTimeAsync(500);
		expect(errorLog.entries).toHaveLength(0);
	});

	it('start() is idempotent — double-start does not double-subscribe', () => {
		errorLog.start();

		let calls = 0;
		const off = onClientError(() => calls++);
		reportClientError({ message: 'once', source: 'idempotency' });
		expect(calls).toBe(1);
		off();
	});

	it('clear() resets suppressedCount', () => {
		errorLog.start();
		errorLog.suppressedCount = 5;
		errorLog.clear();
		expect(errorLog.suppressedCount).toBe(0);
	});
});
