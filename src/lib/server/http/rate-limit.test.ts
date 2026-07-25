import { describe, expect, it } from 'vitest';
import { slidingWindow } from './rate-limit';

describe('slidingWindow', () => {
	it('allows hits under the cap and appends each to the kept list', () => {
		const a = slidingWindow([], 1000, 60_000, 3);
		expect(a.result.limited).toBe(false);
		expect(a.kept).toEqual([1000]);

		const b = slidingWindow(a.kept, 2000, 60_000, 3);
		expect(b.result.limited).toBe(false);
		expect(b.kept).toEqual([1000, 2000]);
	});

	it('limits once the cap is reached within the window, with a Retry-After to the oldest ageing out', () => {
		const hits = [1000, 2000, 3000]; // 3 hits, cap 3
		const { result, kept } = slidingWindow(hits, 3500, 60_000, 3);
		expect(result.limited).toBe(true);
		// oldest (1000) ages out at 1000 + 60000 = 61000; from now (3500) that's 57.5s → ceil 58.
		expect(result.retryAfterSec).toBe(58);
		expect(kept).toEqual(hits); // the rejected hit is not appended
	});

	it('prunes hits outside the window so the cap only counts recent ones', () => {
		const hits = [1000, 2000, 3000]; // all older than the window at now=70000
		const { result, kept } = slidingWindow(hits, 70_000, 60_000, 3);
		expect(result.limited).toBe(false); // all pruned → under cap again
		expect(kept).toEqual([70_000]);
	});

	it('never reports a Retry-After below 1 second', () => {
		// oldest (1000) is still in-window and ages out in 0.5s → clamp up to 1s.
		const { result } = slidingWindow([1000, 1000, 1000], 60_500, 60_000, 3);
		expect(result.limited).toBe(true);
		expect(result.retryAfterSec).toBe(1);
	});
});
