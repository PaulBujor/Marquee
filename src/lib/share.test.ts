import { describe, expect, it, vi } from 'vitest';
import { shareLink, warmPreview, type ShareEnvironment } from './share';

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

		expect(await warmPreview(target, { fetchImpl })).toBe(true);
		expect(calls[0].url).toBe('/api/share/preview');
		expect(calls[0].init.method).toBe('POST');
		expect(calls[0].init.credentials).toBe('same-origin');
		expect(JSON.parse(String(calls[0].init.body))).toEqual(target);
	});

	it('reports anything the server refuses as a failure to warm', async () => {
		for (const status of [400, 404, 429, 503]) {
			const fetchImpl = (async () => new Response('{}', { status })) as unknown as typeof fetch;
			expect(await warmPreview(target, { fetchImpl })).toBe(false);
		}
	});

	it('reports being offline as a failure to warm, without throwing', async () => {
		const fetchImpl = (async () => {
			throw new TypeError('Failed to fetch');
		}) as unknown as typeof fetch;
		expect(await warmPreview(target, { fetchImpl })).toBe(false);
	});

	it('gives up at the cap and aborts the request', async () => {
		let aborted = false;
		const fetchImpl = ((_url: string, init: RequestInit) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener('abort', () => {
					aborted = true;
					reject(new Error('aborted'));
				});
			})) as unknown as typeof fetch;

		expect(await warmPreview(target, { fetchImpl, timeoutMs: 20 })).toBe(false);
		expect(aborted).toBe(true);
	});
});
