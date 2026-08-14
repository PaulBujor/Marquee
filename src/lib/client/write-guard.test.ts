import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guardedWrite } from './write-guard';
import { reportClientError } from './report-error';

vi.mock('./report-error', () => ({ reportClientError: vi.fn() }));
const toastError = vi.fn();
vi.mock('svelte-sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

beforeEach(() => {
	vi.mocked(reportClientError).mockClear();
	toastError.mockClear();
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('guardedWrite', () => {
	it('reports success and stays quiet when the write lands', async () => {
		const ok = await guardedWrite(async () => {}, { source: 's', userMessage: 'nope' });
		expect(ok).toBe(true);
		expect(reportClientError).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});

	it('never lets a failed write pass as a success', async () => {
		// The whole point: an unguarded handler swallowed the rejection, so the dialog closed and the
		// user believed their entry was saved. The caller must be able to see it failed.
		const ok = await guardedWrite(
			async () => {
				throw new Error('idb blocked');
			},
			{ source: 'custom-media:create', userMessage: "Couldn't add that entry" }
		);
		expect(ok).toBe(false);
	});

	it('forwards the failure to the error sink, which the console alone never reaches', async () => {
		await guardedWrite(
			async () => {
				throw new Error('idb blocked');
			},
			{ source: 'custom-media:create', userMessage: "Couldn't add that entry" }
		);
		expect(reportClientError).toHaveBeenCalledWith(
			expect.objectContaining({
				source: 'custom-media:create',
				message: expect.stringContaining('idb blocked')
			})
		);
	});

	it('tells the user, in their terms rather than the exception text', async () => {
		await guardedWrite(
			async () => {
				throw new Error('QuotaExceededError');
			},
			{ source: 'custom-media:edit', userMessage: "Couldn't save those changes" }
		);
		expect(toastError).toHaveBeenCalledWith(
			"Couldn't save those changes",
			expect.objectContaining({ description: expect.any(String) })
		);
	});

	it('handles a thrown non-Error without losing the report', async () => {
		await guardedWrite(
			async () => {
				throw 'a bare string';
			},
			{ source: 's', userMessage: 'm' }
		);
		expect(reportClientError).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining('a bare string') })
		);
	});
});
