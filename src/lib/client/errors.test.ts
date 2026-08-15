import { describe, expect, it, vi } from 'vitest';
import { appendError, formatErrorText, MAX_ERRORS, parseErrors } from './errors';
import { onClientError, reportClientError } from './report-error';

function entry(message: string, over: Partial<Parameters<typeof appendError>[1]> = {}) {
	return { at: 1_000, message, count: 1, ...over };
}

describe('appendError', () => {
	it('keeps the newest first', () => {
		const log = appendError(appendError([], entry('first')), entry('second'));
		expect(log.map((e) => e.message)).toEqual(['second', 'first']);
	});

	it('folds a repeat into a count instead of listing it again', () => {
		// A render loop throws the same error hundreds of times; a log that lists each one is
		// unreadable and pushes the error you actually need off the end.
		let log = appendError([], entry('boom', { source: 'sync' }));
		log = appendError(log, entry('boom', { source: 'sync', at: 2_000 }));
		log = appendError(log, entry('boom', { source: 'sync', at: 3_000 }));

		expect(log).toHaveLength(1);
		expect(log[0]).toMatchObject({ count: 3, at: 3_000 });
	});

	it('treats the same message from a different source as its own error', () => {
		let log = appendError([], entry('failed', { source: 'sync' }));
		log = appendError(log, entry('failed', { source: 'idb' }));
		expect(log).toHaveLength(2);
	});

	it('moves a recurring error back to the top', () => {
		let log = appendError([], entry('old', { source: 'a' }));
		log = appendError(log, entry('new', { source: 'b' }));
		log = appendError(log, entry('old', { source: 'a', at: 5_000 }));
		expect(log.map((e) => e.message)).toEqual(['old', 'new']);
	});

	it('caps the log, dropping the oldest', () => {
		let log: ReturnType<typeof appendError> = [];
		for (let i = 0; i < MAX_ERRORS + 5; i++) log = appendError(log, entry(`e${i}`));
		expect(log).toHaveLength(MAX_ERRORS);
		expect(log[0].message).toBe(`e${MAX_ERRORS + 4}`);
		expect(log.some((e) => e.message === 'e0')).toBe(false);
	});
});

describe('formatErrorText', () => {
	it('renders something pasteable, with the repeat count and stack', () => {
		const text = formatErrorText([
			entry('Boom', { source: 'sync', count: 3, stack: 'at foo\nat bar', url: '/title/movie/1' })
		]);
		expect(text).toContain('[sync]');
		expect(text).toContain('(×3)');
		expect(text).toContain('Boom');
		expect(text).toContain('at /title/movie/1');
		expect(text).toContain('  at foo');
	});

	it('says so when there is nothing to report', () => {
		expect(formatErrorText([])).toBe('No errors recorded.');
	});
});

describe('parseErrors', () => {
	it('restores a persisted log and defaults a missing count', () => {
		const raw = JSON.stringify([{ at: 1, message: 'a' }]);
		expect(parseErrors(raw)).toEqual([{ at: 1, message: 'a', count: 1 }]);
	});

	it('survives anything that is not a log', () => {
		expect(parseErrors(null)).toEqual([]);
		expect(parseErrors('not json')).toEqual([]);
		expect(parseErrors('{"nope":true}')).toEqual([]);
		expect(parseErrors('[{"no":"message"}]')).toEqual([]);
	});
});

describe('onClientError', () => {
	it('notifies listeners for every report', () => {
		const seen: string[] = [];
		const off = onClientError((r) => seen.push(r.message));
		reportClientError({ message: 'one' });
		reportClientError({ message: 'two', handled: true });
		off();
		reportClientError({ message: 'three' });

		// `handled` still reaches the listener — it suppresses a second toast, not the record.
		expect(seen).toEqual(['one', 'two']);
	});

	it('keeps reporting when a listener throws', () => {
		// Surfacing an error must never be able to lose it.
		const seen: string[] = [];
		const offBad = onClientError(() => {
			throw new Error('listener is broken');
		});
		const offGood = onClientError((r) => seen.push(r.message));
		expect(() => reportClientError({ message: 'still recorded' })).not.toThrow();
		expect(seen).toEqual(['still recorded']);
		offBad();
		offGood();
	});

	it('does not throw when there is no fetch to send with', () => {
		const original = globalThis.fetch;
		// @ts-expect-error — deleting the global is the point of the test
		delete globalThis.fetch;
		try {
			expect(() => reportClientError({ message: 'no transport' })).not.toThrow();
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe('reportClientError transport', () => {
	it('posts the report and swallows a failed send', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
		const original = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		try {
			expect(() => reportClientError({ message: 'boom', source: 'test' })).not.toThrow();
			expect(fetchMock).toHaveBeenCalledWith('/api/client-error', expect.anything());
		} finally {
			globalThis.fetch = original;
		}
	});
});
