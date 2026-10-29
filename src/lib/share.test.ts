import { describe, expect, it, vi } from 'vitest';
import {
	shareAndWarm,
	shareLink,
	warmPreview,
	type ShareEnvironment,
	type WarmOutcome
} from './share';

const content = { title: 'Severance (2022)', url: 'https://marquee.example/title/show/95396' };

function env(overrides: ShareEnvironment = {}): ShareEnvironment & {
	copied: string[];
	shared: number;
} {
	const copied: string[] = [];
	const state = { copied, shared: 0 };
	return Object.assign(state, {
		writeText: async (text: string) => {
			copied.push(text);
		},
		...overrides
	});
}

describe('shareLink', () => {
	it('uses the OS share sheet when the platform has one', async () => {
		const share = vi.fn(async () => {});
		const environment = env({ share });
		expect(await shareLink(content, environment)).toBe('shared');
		expect(share).toHaveBeenCalledWith(content);
		expect(environment.copied).toEqual([]);
	});

	it('reports a dismissed sheet as cancelled and copies nothing', async () => {
		const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
		const environment = env({
			share: async () => {
				throw abort;
			}
		});
		expect(await shareLink(content, environment)).toBe('cancelled');
		expect(environment.copied).toEqual([]);
	});

	it('falls back to the clipboard when the sheet breaks', async () => {
		const environment = env({
			share: async () => {
				throw new Error('NotAllowedError');
			}
		});
		expect(await shareLink(content, environment)).toBe('copied');
		expect(environment.copied).toEqual([content.url]);
	});

	it('copies when the platform has no sheet', async () => {
		const environment = env();
		expect(await shareLink(content, environment)).toBe('copied');
		expect(environment.copied).toEqual([content.url]);
	});

	it('skips a sheet that cannot take this payload', async () => {
		const share = vi.fn(async () => {});
		const environment = env({ share, canShare: () => false });
		expect(await shareLink(content, environment)).toBe('copied');
		expect(share).not.toHaveBeenCalled();
	});

	it('fails when neither route works', async () => {
		expect(await shareLink(content, {})).toBe('failed');
		expect(
			await shareLink(content, {
				writeText: async () => {
					throw new Error('denied');
				}
			})
		).toBe('failed');
	});
});

describe('warmPreview', () => {
	const target = { type: 'movie', id: 603 } as const;

	it('asks the server to store the preview, same-origin', async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const fetchImpl = (async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return new Response(JSON.stringify({ status: 'warmed' }), { status: 200 });
		}) as unknown as typeof fetch;

		expect(await warmPreview(target, { fetchImpl })).toBe('stored');
		expect(calls[0].url).toBe('/api/share/preview');
		expect(calls[0].init.method).toBe('POST');
		expect(calls[0].init.credentials).toBe('same-origin');
		expect(JSON.parse(String(calls[0].init.body))).toEqual(target);
	});

	it('reports anything the server refuses as a failure to warm', async () => {
		for (const status of [400, 404, 429, 503]) {
			const fetchImpl = (async () => new Response('{}', { status })) as unknown as typeof fetch;
			expect(await warmPreview(target, { fetchImpl })).toBe('failed');
		}
	});

	it('reports being offline as a failure to warm, without throwing', async () => {
		const fetchImpl = (async () => {
			throw new TypeError('Failed to fetch');
		}) as unknown as typeof fetch;
		expect(await warmPreview(target, { fetchImpl })).toBe('failed');
	});

	it('gives up at the cap, and reports a timeout rather than a failure', async () => {
		let aborted = false;
		const fetchImpl = ((_url: string, init: RequestInit) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener('abort', () => {
					aborted = true;
					// What the browser actually rejects with — the row may still land server-side.
					reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
				});
			})) as unknown as typeof fetch;

		expect(await warmPreview(target, { fetchImpl, timeoutMs: 20 })).toBe('timeout');
		expect(aborted).toBe(true);
	});
});

describe('shareAndWarm', () => {
	it('opens the sheet without waiting for the warm to settle', async () => {
		let settle: (outcome: WarmOutcome) => void = () => {};
		const warm = vi.fn(() => new Promise<WarmOutcome>((resolve) => (settle = resolve)));
		const share = vi.fn(async () => 'shared' as const);

		const pending = shareAndWarm(content, { type: 'movie', id: 603 }, { warm, share });

		// Already called, with the warm still in flight — that is the property, not an implementation
		// detail, and it is what keeps the sheet inside the gesture that opened it.
		expect(share).toHaveBeenCalledTimes(1);
		expect(warm).toHaveBeenCalledWith({ type: 'movie', id: 603 });

		settle('timeout');
		expect(await pending).toEqual({ outcome: 'shared', warmed: 'timeout' });
	});

	it('still reports a preview that never stored, and skips the warm when there is nothing to warm', async () => {
		const warm = vi.fn(async () => 'failed' as const);
		const share = vi.fn(async () => 'copied' as const);

		expect(await shareAndWarm(content, { type: 'show', id: 95396 }, { warm, share })).toEqual({
			outcome: 'copied',
			warmed: 'failed'
		});

		expect(await shareAndWarm(content, undefined, { warm, share })).toEqual({
			outcome: 'copied',
			warmed: 'stored'
		});
		expect(warm).toHaveBeenCalledTimes(1);
	});
});
