import { describe, expect, it } from 'vitest';
import { slidingWindow, withinRateLimit } from './rate-limit';

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

describe('withinRateLimit', () => {
	const request = (ip?: string) =>
		new Request('https://marquee.example/s/movie/603', {
			headers: ip ? { 'cf-connecting-ip': ip } : {}
		});
	const limiter = (impl: () => Promise<{ success: boolean }>) => ({ limit: impl }) as RateLimit;

	it('allows when there is no binding or no client IP, so dev and tests are unaffected', async () => {
		expect(await withinRateLimit(undefined, request('203.0.113.9'))).toBe(true);
		expect(
			await withinRateLimit(
				limiter(async () => ({ success: true })),
				request()
			)
		).toBe(true);
	});

	it('keys the budget on the client IP', async () => {
		const keys: string[] = [];
		const recording = {
			limit: async ({ key }: { key: string }) => {
				keys.push(key);
				return { success: true };
			}
		} as RateLimit;

		await withinRateLimit(recording, request('203.0.113.9'));
		expect(keys).toEqual(['203.0.113.9']);
	});

	it('counts an IPv6 client by its /64, so rotating the host bits shares one budget', async () => {
		const keys: string[] = [];
		const recording = {
			limit: async ({ key }: { key: string }) => {
				keys.push(key);
				return { success: true };
			}
		} as RateLimit;

		await withinRateLimit(recording, request('2001:db8:1:2:aaaa:bbbb:cccc:dddd'));
		await withinRateLimit(recording, request('2001:db8:1:2:1111:2222:3333:4444'));

		expect(keys).toEqual(['2001:db8:1:2::/64', '2001:db8:1:2::/64']);
	});

	it('denies a reader who is over budget', async () => {
		expect(
			await withinRateLimit(
				limiter(async () => ({ success: false })),
				request('203.0.113.9')
			)
		).toBe(false);
	});

	it('allows when the limiter itself fails — a backstop must not take the app down', async () => {
		const broken = limiter(async () => {
			throw new Error('limiter unavailable');
		});
		expect(await withinRateLimit(broken, request('203.0.113.9'))).toBe(true);
	});
});
