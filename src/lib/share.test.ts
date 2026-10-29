import { describe, expect, it, vi } from 'vitest';
import { shareLink, type ShareEnvironment } from './share';

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
