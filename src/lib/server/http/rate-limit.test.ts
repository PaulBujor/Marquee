import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { actorRateLimitKey, rateLimitKey, slidingWindow, withinRateLimit } from './rate-limit';

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

function request(opts: { ip?: string; cookie?: string } = {}) {
	return new Request('https://marquee.example/s/movie/603', {
		headers: {
			...(opts.ip ? { 'cf-connecting-ip': opts.ip } : {}),
			...(opts.cookie ? { cookie: opts.cookie } : {})
		}
	});
}

async function ipKey(opts: { ip?: string; cookie?: string } = { ip: '203.0.113.9' }) {
	return rateLimitKey(request(opts));
}

function platform(limiter: unknown) {
	return { env: { APP_RATE_LIMITER: limiter } } as unknown as App.Platform;
}

function limiter(impl: () => Promise<{ success: boolean }>) {
	return { limit: impl } as RateLimit;
}

describe('withinRateLimit', () => {
	it('allows when there are no bindings at all — build, prerender and unit tests have no platform', async () => {
		expect(await withinRateLimit(undefined, 'APP_RATE_LIMITER', await ipKey())).toBe(true);
	});

	it('allows but says so once when a deployed environment is missing the binding', async () => {
		const bare = { env: {} } as unknown as App.Platform;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		expect(await withinRateLimit(bare, 'APP_RATE_LIMITER', await ipKey())).toBe(true);
		expect(await withinRateLimit(bare, 'APP_RATE_LIMITER', await ipKey())).toBe(true);

		// Once per isolate, not once per request.
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0][0])).toContain('APP_RATE_LIMITER');
		warn.mockRestore();
	});

	it('never keys a request on a cookie the caller chose', async () => {
		// This runs before `authentication`, so a cookie here is unverified input: keying on it would
		// hand anyone who sends a random one a fresh budget with every request.
		expect(await ipKey({ ip: '203.0.113.9', cookie: 'session=forged' })).toBe('ip:203.0.113.9');
		expect(await ipKey({ ip: '203.0.113.9' })).toBe('ip:203.0.113.9');
	});

	it('keys a verified caller by account, so two neighbours on one address do not share one budget', () => {
		expect(actorRateLimitKey('user-1')).toBe('user:user-1');
		expect(actorRateLimitKey(undefined)).toBeNull();
	});

	it('keys by the client IP, grouping IPv6 by its /64', async () => {
		expect(await rateLimitKey(request({ ip: '203.0.113.9' }))).toBe('ip:203.0.113.9');
		expect(await rateLimitKey(request({ ip: '2001:db8:1:2:aaaa:bbbb:cccc:dddd' }))).toBe(
			'ip:2001:db8:1:2::/64'
		);
		expect(await rateLimitKey(request())).toBeNull();
	});

	it('denies a caller who is over budget, and allows one the limiter itself failed on', async () => {
		expect(
			await withinRateLimit(
				platform(limiter(async () => ({ success: false }))),
				'APP_RATE_LIMITER',
				await ipKey()
			)
		).toBe(false);

		const broken = limiter(async () => {
			throw new Error('limiter unavailable');
		});
		expect(await withinRateLimit(platform(broken), 'APP_RATE_LIMITER', await ipKey())).toBe(true);
	});
});

describe('wrangler configuration', () => {
	interface WranglerEnv {
		ratelimits?: { name: string }[];
		analytics_engine_datasets?: { binding: string }[];
		env?: { preview: WranglerEnv };
	}

	function parseJsonc(text: string): WranglerEnv {
		let out = '';
		let inString = false;
		for (let i = 0; i < text.length; i++) {
			const char = text[i];
			if (inString) {
				out += char;
				if (char === '\\') out += text[++i] ?? '';
				else if (char === '"') inString = false;
				continue;
			}
			if (char === '"') inString = true;
			else if (char === '/' && text[i + 1] === '/') {
				while (i < text.length && text[i] !== '\n') i++;
				continue;
			}
			out += char;
		}
		return JSON.parse(out);
	}

	// `withinRateLimit` fails open, so a binding that goes missing in an environment is invisible at
	// runtime — the only place to catch it is here.
	it('declares both rate limits in every environment', () => {
		const config = parseJsonc(readFileSync(join(process.cwd(), 'wrangler.jsonc'), 'utf8'));
		const envs = [config, config.env!.preview];

		for (const env of envs) {
			// A binding declared in only one environment is invisible at runtime: the helper fails open
			// and wrangler doesn't inherit bindings, so the preview env would simply be unlimited.
			const names = (env.ratelimits ?? []).map((b: { name: string }) => b.name).sort();
			expect(names).toEqual(['APP_RATE_LIMITER', 'PUBLIC_SHARE_LIMITER']);
		}
	});
});
